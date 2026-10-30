#!/usr/bin/env bash
# Builds the image in Azure Container Registry (no local Docker needed) and deploys
# the portal to Azure Container Apps with deploy/azure/main.bicep.
#
#   cp deploy/azure/azure.env.example deploy/azure/azure.env   # fill it in
#   az login
#   bash deploy/azure/deploy.sh [path/to/azure.env]
#
# Re-run the same command to deploy a new version. WHAT_IF=true previews changes only.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
ENV_FILE="${1:-$HERE/azure.env}"

say() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || fail "Settings file not found: $ENV_FILE (copy azure.env.example)"
set -a; . "$ENV_FILE"; set +a

command -v az >/dev/null || fail "Azure CLI not found. Install it: https://learn.microsoft.com/cli/azure/install-azure-cli"
command -v node >/dev/null || fail "Node.js is required to prepare deployment parameters"
az account show >/dev/null 2>&1 || fail "Not signed in. Run: az login"

for v in RESOURCE_GROUP LOCATION NAME_PREFIX ACR_NAME STORAGE_REGION STORAGE_BUCKET STORAGE_ACCESS_KEY_ID STORAGE_SECRET_ACCESS_KEY; do
  [ -n "${!v:-}" ] || fail "$v is required in $ENV_FILE"
done
if [ "${CREATE_DATABASE:-true}" = "true" ]; then
  [ -n "${POSTGRES_ADMIN_PASSWORD:-}" ] || fail "POSTGRES_ADMIN_PASSWORD is required"
else
  [ -n "${DATABASE_URL:-}" ] || fail "DATABASE_URL is required when CREATE_DATABASE=false"
fi
if [ -z "${SESSION_SECRET:-}" ]; then
  SESSION_SECRET="$(node -e 'console.log(require("crypto").randomBytes(48).toString("base64"))')"
  # Keep it stable across deployments, otherwise every deployment signs everyone out.
  if grep -q '^SESSION_SECRET=' "$ENV_FILE"; then
    node -e 'const fs=require("fs");const [f,v]=process.argv.slice(1);fs.writeFileSync(f,fs.readFileSync(f,"utf8").replace(/^SESSION_SECRET=.*$/m,"SESSION_SECRET="+v))' "$ENV_FILE" "$SESSION_SECRET"
  else
    printf '\nSESSION_SECRET=%s\n' "$SESSION_SECRET" >> "$ENV_FILE"
  fi
  echo "Generated SESSION_SECRET and saved it to $ENV_FILE"
fi

say "Preparing Azure (subscription: $(az account show --query name -o tsv))"
az extension add --name containerapp --upgrade --only-show-errors >/dev/null
for ns in Microsoft.App Microsoft.OperationalInsights Microsoft.DBforPostgreSQL Microsoft.ContainerRegistry Microsoft.ManagedIdentity; do
  az provider register --namespace "$ns" --wait >/dev/null
done
az group create --name "$RESOURCE_GROUP" --location "$LOCATION" --output none
if ! az acr show --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" >/dev/null 2>&1; then
  az acr create --name "$ACR_NAME" --resource-group "$RESOURCE_GROUP" --sku Basic --admin-enabled false --output none
fi

TAG="${IMAGE_TAG:-$(date +%Y%m%d-%H%M%S)}"
IMAGE="$(az acr show --name "$ACR_NAME" --query loginServer -o tsv)/tekpro-portal:$TAG"
say "Building $IMAGE in Azure Container Registry"
az acr build --registry "$ACR_NAME" --image "tekpro-portal:$TAG" --image "tekpro-portal:latest" \
  --platform linux/amd64 --file "$ROOT/Dockerfile" "$ROOT"

PARAMS="$(mktemp)"
trap 'rm -f "$PARAMS"' EXIT
chmod 600 "$PARAMS"
IMAGE="$IMAGE" node -e '
const e = process.env;
const p = {
  namePrefix: e.NAME_PREFIX, location: e.LOCATION, acrName: e.ACR_NAME, image: e.IMAGE,
  appBaseUrl: e.APP_BASE_URL || "", minReplicas: Number(e.MIN_REPLICAS || 1), maxReplicas: Number(e.MAX_REPLICAS || 3),
  createDatabase: (e.CREATE_DATABASE || "true") === "true", postgresAdminLogin: e.POSTGRES_ADMIN_LOGIN || "portaladmin",
  postgresAdminPassword: e.POSTGRES_ADMIN_PASSWORD || "", databaseUrl: e.DATABASE_URL || "",
  sessionSecret: e.SESSION_SECRET, storageRegion: e.STORAGE_REGION, storageBucket: e.STORAGE_BUCKET,
  storageAccessKeyId: e.STORAGE_ACCESS_KEY_ID, storageSecretAccessKey: e.STORAGE_SECRET_ACCESS_KEY, storageEndpoint: e.STORAGE_ENDPOINT || "",
  mailDriver: e.MAIL_DRIVER || "disabled", mailFrom: e.MAIL_FROM || "Tekpro Document Portal <no-reply@example.com>",
  smtpHost: e.SMTP_HOST || "", smtpPort: String(e.SMTP_PORT || "587"), smtpUser: e.SMTP_USER || "", smtpPassword: e.SMTP_PASSWORD || "",
  allowAdminResetLinks: (e.ALLOW_ADMIN_RESET_LINKS || "false") === "true",
  connectorEncryptionKey: e.CONNECTOR_ENCRYPTION_KEY || "", connectorAwsAccessKeyId: e.CONNECTOR_AWS_ACCESS_KEY_ID || "",
  connectorAwsSecretAccessKey: e.CONNECTOR_AWS_SECRET_ACCESS_KEY || "",
};
const parameters = Object.fromEntries(Object.entries(p).map(([k, v]) => [k, { value: v }]));
require("fs").writeFileSync(process.argv[1], JSON.stringify({ $schema: "https://schema.management.azure.com/schemas/2019-04-01/deploymentParameters.json#", contentVersion: "1.0.0.0", parameters }));
' "$PARAMS"

if [ "${WHAT_IF:-false}" = "true" ]; then
  say "Previewing changes (what-if); nothing will be deployed"
  az deployment group what-if --resource-group "$RESOURCE_GROUP" --template-file "$HERE/main.bicep" --parameters "@$PARAMS"
  exit 0
fi

say "Deploying infrastructure and the container app (the first run takes 10-15 minutes)"
az deployment group create --resource-group "$RESOURCE_GROUP" --name "tekpro-portal-$TAG" \
  --template-file "$HERE/main.bicep" --parameters "@$PARAMS" --output none
URL="$(az deployment group show --resource-group "$RESOURCE_GROUP" --name "tekpro-portal-$TAG" --query properties.outputs.portalUrl.value -o tsv)"
APP="$(az deployment group show --resource-group "$RESOURCE_GROUP" --name "tekpro-portal-$TAG" --query properties.outputs.containerAppName.value -o tsv)"

say "Waiting for the new version to become healthy"
for _ in $(seq 1 30); do
  if curl -fsS "$URL/api/v1/health/ready" >/dev/null 2>&1; then break; fi
  sleep 10
done
curl -fsS "$URL/api/v1/health/ready" && echo || echo "Not ready yet - check logs: az containerapp logs show -n $APP -g $RESOURCE_GROUP --follow"

cat <<MSG

Deployed: $URL

First deployment only - create the first Super Admin (prompts for email, name, password):
  az containerapp exec -n $APP -g $RESOURCE_GROUP --command "/nodejs/bin/node /app/docker/entrypoint.mjs bootstrap-superadmin"

Add $URL to the Lightsail bucket CORS rule (AllowedOrigins), then run:
  az containerapp exec -n $APP -g $RESOURCE_GROUP --command "/nodejs/bin/node /app/docker/entrypoint.mjs storage-check"
MSG
