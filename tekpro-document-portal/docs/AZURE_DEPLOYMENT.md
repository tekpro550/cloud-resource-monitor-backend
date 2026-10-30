# Deploying on Azure Container Apps

The portal ships as one container image (API + web app, port 3000). This guide deploys it to
**Azure Container Apps** with **Azure Database for PostgreSQL**. Document files stay in the
Lightsail bucket (or customers' own buckets); Azure only runs the application and database.

```
Browser ──HTTPS──▶ Azure Container Apps (managed TLS, autoscaling, 1-3 replicas)
                        │  image from Azure Container Registry (pulled with a managed identity)
                        ├──TLS──▶ Azure Database for PostgreSQL Flexible Server 16
                        └──TLS──▶ Lightsail bucket (S3 API) ◀── browsers upload/download directly
```

## What gets created

| Resource | Default | Notes |
|---|---|---|
| Resource group | `tekpro-portal-rg` | |
| Container Registry | Basic | Image is built here by `az acr build`; no Docker needed on your machine |
| Log Analytics workspace | 30-day retention | Container logs (structured JSON) |
| Container Apps environment + app | 0.5 vCPU / 1 GiB, min 1, max 3 replicas | HTTPS ingress, health probes, autoscale at 50 concurrent requests per replica |
| User-assigned managed identity | AcrPull on the registry | No registry passwords |
| PostgreSQL Flexible Server 16 | Burstable B1ms, 32 GB, 7-day backups | TLS required; firewall allows Azure services |

Sizes are starting assumptions for the initial workload (see TESTING.md: load testing is still to be done).

## 1. Prerequisites

- An Azure subscription with permission to create resources and role assignments (Owner, or
  Contributor + User Access Administrator, on the resource group).
- [Azure CLI](https://learn.microsoft.com/cli/azure/install-azure-cli) 2.60+ and Node.js 22 on your machine.
- The Lightsail bucket and its access key (see DEPLOYMENT.md §8).

## 2. Configure

```bash
cd tekpro-document-portal
cp deploy/azure/azure.env.example deploy/azure/azure.env
```

Edit `deploy/azure/azure.env` (it is git-ignored):

- `ACR_NAME`: globally unique, lowercase letters and digits.
- `POSTGRES_ADMIN_PASSWORD`: strong password.
- `STORAGE_*`: Lightsail bucket region, name and access key.
- `MAIL_DRIVER=smtp` with the `SMTP_*` settings, so invitations and password resets are emailed. Until
  email works you may set `ALLOW_ADMIN_RESET_LINKS=true`.
- `SESSION_SECRET` is generated on the first run and saved back into the file. Keep it stable,
  because changing it signs everyone out.

## 3. Deploy

```bash
az login
bash deploy/azure/deploy.sh                 # first run: ~10-15 minutes
```

Optional preview of changes without deploying: `WHAT_IF=true bash deploy/azure/deploy.sh`.

The script registers the resource providers, creates the resource group and registry, builds the image
in the registry (`linux/amd64`), deploys `deploy/azure/main.bicep`, waits for `/api/v1/health/ready`,
and prints the portal URL, e.g. `https://tekpro-portal.<unique>.centralindia.azurecontainerapps.io`.

On start the container applies any pending database migrations, then starts the server.

## 4. After the first deployment

1. **Allow browser uploads to the bucket:** add the printed portal URL to the Lightsail bucket CORS
   rule's allowed origins (DEPLOYMENT.md §10).
2. **Create the first Super Admin** (prompts for email, name and a hidden password):
   ```bash
   az containerapp exec -n tekpro-portal -g tekpro-portal-rg \
     --command "/nodejs/bin/node /app/docker/entrypoint.mjs bootstrap-superadmin"
   ```
3. **Check storage:**
   ```bash
   az containerapp exec -n tekpro-portal -g tekpro-portal-rg \
     --command "/nodejs/bin/node /app/docker/entrypoint.mjs storage-check"
   ```
4. Open the URL and sign in.

## 5. Custom domain (e.g. portal.tekpro.example)

```bash
az containerapp hostname add  -n tekpro-portal -g tekpro-portal-rg --hostname portal.tekpro.example
# Create the DNS records the command asks for (CNAME + TXT asuid), then:
az containerapp hostname bind -n tekpro-portal -g tekpro-portal-rg --hostname portal.tekpro.example \
  --environment tekpro-env --validation-method CNAME     # free managed certificate
```

Then set `APP_BASE_URL=https://portal.tekpro.example` in `azure.env`, run `deploy.sh` again, and update
the bucket CORS rule to the new origin.

## 6. Operations

| Task | Command |
|---|---|
| Live logs | `az containerapp logs show -n tekpro-portal -g tekpro-portal-rg --follow` |
| Query logs | Log Analytics → `ContainerAppConsoleLogs_CL \| where ContainerAppName_s == "tekpro-portal"` |
| Deploy a new version | `bash deploy/azure/deploy.sh` (builds a new image tag; zero-downtime revision switch) |
| List versions | `az containerapp revision list -n tekpro-portal -g tekpro-portal-rg -o table` |
| Roll back the app | `az containerapp update -n tekpro-portal -g tekpro-portal-rg --image <acr>.azurecr.io/tekpro-portal:<previous-tag>` |
| Reconcile storage | `az containerapp exec ... --command "/nodejs/bin/node /app/docker/entrypoint.mjs jobs reconcile"` |
| Scale | change `MIN_REPLICAS` / `MAX_REPLICAS` and redeploy |

Maintenance jobs (upload expiry, purges, session pruning) run inside the app every 15 minutes; a database
lease ensures only one replica runs them at a time.

**Rollback and migrations:** migrations are applied automatically when a new version starts. Rolling back
the image does not undo a migration. Take a backup point (PostgreSQL point-in-time restore covers the
last 7 days) before deploying a version with schema changes (see BACKUP_RECOVERY.md).

## 7. Backups

Azure Database for PostgreSQL takes automatic backups with point-in-time restore (7 days by default;
raise `backupRetentionDays` in `main.bicep` for longer). Restore creates a new server; point
`DATABASE_URL` at it (`CREATE_DATABASE=false`) and redeploy. Object storage backups are covered in
BACKUP_RECOVERY.md.

## 8. Security notes

- The image runs as a non-root user on a distroless base (no shell or package manager); the app files are
  read-only for that user.
- Secrets are Container Apps secrets (not plain environment values) and the deployment parameters file is
  created with mode 600 and deleted after use.
- Ingress is HTTPS-only. `TRUST_PROXY=1` trusts exactly the Container Apps ingress hop so rate limiting
  and audit logs see real client IPs.
- The database firewall rule *AllowAzureServices* admits connections from any Azure IP; access still
  needs the password and TLS. For stricter isolation, put the Container Apps environment and the database
  in a virtual network with private access (not included in this template).
- The app connects as the PostgreSQL admin login. For least privilege, create a dedicated role that owns
  only the `tekpro_portal` database and switch `DATABASE_URL` to it (`CREATE_DATABASE=false`).

## 9. Running the image elsewhere

```bash
docker build --platform linux/amd64 -t tekpro-portal .
docker run -p 3000:3000 --env-file .env tekpro-portal                      # serve (runs migrations first)
docker run --rm -it --env-file .env tekpro-portal bootstrap-superadmin      # first admin
docker run --rm --env-file .env tekpro-portal jobs reconcile               # maintenance
```

Commands: `serve` (default), `migrate`, `bootstrap-superadmin`, `jobs`, `storage-check`. Set
`RUN_MIGRATIONS=false` to start without migrating (e.g. when migrations are applied by a separate step).
