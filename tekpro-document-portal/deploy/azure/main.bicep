// Tekpro Document Portal on Azure Container Apps.
//
// Creates: Log Analytics workspace, Container Apps environment, user-assigned identity
// with AcrPull on the existing registry, Azure Database for PostgreSQL Flexible Server
// (optional), and the portal Container App (HTTPS ingress, secrets, probes, autoscaling).
// Documents are stored in the S3-compatible bucket configured below (Lightsail).
//
// Deploy with deploy/azure/deploy.sh (builds the image in ACR, then runs this template).

targetScope = 'resourceGroup'

@description('Azure region.')
param location string = resourceGroup().location

@description('Short prefix for resource names (lowercase letters/digits).')
@maxLength(12)
param namePrefix string = 'tekpro'

@description('Name of the existing Azure Container Registry holding the image.')
param acrName string

@description('Image reference, e.g. myacr.azurecr.io/tekpro-portal:20261030-1')
param image string

@description('Public URL of the portal. Leave empty to use the Container App default HTTPS address.')
param appBaseUrl string = ''

@description('Container size.')
param cpu string = '0.5'
param memory string = '1Gi'
@minValue(1)
param minReplicas int = 1
@minValue(1)
param maxReplicas int = 3

// ----------------------------------------------------------------- database
@description('Create an Azure Database for PostgreSQL Flexible Server. Set false to supply databaseUrl.')
param createDatabase bool = true
param postgresAdminLogin string = 'portaladmin'
@secure()
@description('PostgreSQL admin password (when createDatabase=true).')
param postgresAdminPassword string = ''
@description('PostgreSQL SKU. Burstable B1ms suits the initial workload; use General Purpose for production SLAs.')
param postgresSkuName string = 'Standard_B1ms'
param postgresSkuTier string = 'Burstable'
param postgresStorageGb int = 32
@secure()
@description('Existing database connection string (when createDatabase=false). Must include sslmode=require.')
param databaseUrl string = ''

// ------------------------------------------------------------- application
@secure()
@description('At least 32 random characters (openssl rand -base64 48).')
param sessionSecret string

@description('Platform storage (Lightsail bucket).')
param storageRegion string
param storageBucket string
@secure()
param storageAccessKeyId string
@secure()
param storageSecretAccessKey string
@description('Optional custom S3 endpoint; empty for Lightsail/S3.')
param storageEndpoint string = ''

@description('Email: smtp or disabled.')
@allowed(['smtp', 'disabled'])
param mailDriver string = 'disabled'
param mailFrom string = 'Tekpro Document Portal <no-reply@example.com>'
param smtpHost string = ''
param smtpPort string = '587'
param smtpUser string = ''
@secure()
param smtpPassword string = ''
param allowAdminResetLinks bool = false

@description('Optional: customer-owned storage connectors (see docs/STORAGE_CONNECTORS.md).')
@secure()
param connectorEncryptionKey string = ''
@secure()
param connectorAwsAccessKeyId string = ''
@secure()
param connectorAwsSecretAccessKey string = ''

param tags object = { app: 'tekpro-document-portal' }

// ---------------------------------------------------------------- names
var suffix = uniqueString(resourceGroup().id, namePrefix)
var appName = '${namePrefix}-portal'
var pgServerName = '${namePrefix}-pg-${suffix}'
var dbName = 'tekpro_portal'
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'

// ---------------------------------------------------------------- logging
resource logs 'Microsoft.OperationalInsights/workspaces@2022-10-01' = {
  name: '${namePrefix}-logs-${suffix}'
  location: location
  tags: tags
  properties: {
    sku: { name: 'PerGB2018' }
    retentionInDays: 30
  }
}

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: '${namePrefix}-env'
  location: location
  tags: tags
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: logs.properties.customerId
        sharedKey: logs.listKeys().primarySharedKey
      }
    }
  }
}

// ---------------------------------------------------------- image pulling
resource acr 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = {
  name: acrName
}

resource pullIdentity 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: '${namePrefix}-portal-identity'
  location: location
  tags: tags
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  name: guid(acr.id, pullIdentity.id, acrPullRoleId)
  scope: acr
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: pullIdentity.properties.principalId
    principalType: 'ServicePrincipal'
  }
}

// --------------------------------------------------------------- database
resource pg 'Microsoft.DBforPostgreSQL/flexibleServers@2024-08-01' = if (createDatabase) {
  name: pgServerName
  location: location
  tags: tags
  sku: {
    name: postgresSkuName
    tier: postgresSkuTier
  }
  properties: {
    version: '16'
    administratorLogin: postgresAdminLogin
    administratorLoginPassword: postgresAdminPassword
    storage: { storageSizeGB: postgresStorageGb }
    backup: {
      backupRetentionDays: 7
      geoRedundantBackup: 'Disabled'
    }
    highAvailability: { mode: 'Disabled' }
    network: { publicNetworkAccess: 'Enabled' }
  }
}

// Allows connections from Azure services (including Container Apps). TLS is required.
// For stricter isolation, deploy the environment and the server into a VNet instead.
resource pgFirewall 'Microsoft.DBforPostgreSQL/flexibleServers/firewallRules@2024-08-01' = if (createDatabase) {
  parent: pg
  name: 'AllowAzureServices'
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '0.0.0.0'
  }
}

resource pgDb 'Microsoft.DBforPostgreSQL/flexibleServers/databases@2024-08-01' = if (createDatabase) {
  parent: pg
  name: dbName
  properties: {
    charset: 'UTF8'
    collation: 'en_US.utf8'
  }
}

var effectiveDatabaseUrl = createDatabase
  ? 'postgresql://${postgresAdminLogin}:${uriComponent(postgresAdminPassword)}@${pg.properties.fullyQualifiedDomainName}:5432/${dbName}?sslmode=require'
  : databaseUrl

// ------------------------------------------------------------ container app
var portalUrl = empty(appBaseUrl) ? 'https://${appName}.${env.properties.defaultDomain}' : appBaseUrl

var baseSecrets = [
  { name: 'database-url', value: effectiveDatabaseUrl }
  { name: 'session-secret', value: sessionSecret }
  { name: 'storage-access-key-id', value: storageAccessKeyId }
  { name: 'storage-secret-access-key', value: storageSecretAccessKey }
]
var smtpSecrets = empty(smtpPassword) ? [] : [{ name: 'smtp-password', value: smtpPassword }]
var connectorSecrets = concat(
  empty(connectorEncryptionKey) ? [] : [{ name: 'connector-encryption-key', value: connectorEncryptionKey }],
  empty(connectorAwsAccessKeyId) ? [] : [
    { name: 'connector-aws-access-key-id', value: connectorAwsAccessKeyId }
    { name: 'connector-aws-secret-access-key', value: connectorAwsSecretAccessKey }
  ]
)

var baseEnv = [
  { name: 'NODE_ENV', value: 'production' }
  { name: 'PORT', value: '3000' }
  { name: 'APP_BASE_URL', value: portalUrl }
  // Container Apps terminates TLS in its ingress proxy: trust exactly one hop so
  // rate limiting and audit logs see the real client IP.
  { name: 'TRUST_PROXY', value: '1' }
  { name: 'DATABASE_URL', secretRef: 'database-url' }
  { name: 'SESSION_SECRET', secretRef: 'session-secret' }
  { name: 'STORAGE_DRIVER', value: 's3' }
  { name: 'STORAGE_REGION', value: storageRegion }
  { name: 'STORAGE_BUCKET', value: storageBucket }
  { name: 'STORAGE_ACCESS_KEY_ID', secretRef: 'storage-access-key-id' }
  { name: 'STORAGE_SECRET_ACCESS_KEY', secretRef: 'storage-secret-access-key' }
  // Maintenance runs in-process; a database lease ensures one replica runs it at a time.
  { name: 'JOBS_ENABLED', value: 'true' }
  { name: 'MAIL_DRIVER', value: mailDriver }
  { name: 'MAIL_FROM', value: mailFrom }
  { name: 'ALLOW_ADMIN_RESET_LINKS', value: string(allowAdminResetLinks) }
  { name: 'LOG_LEVEL', value: 'info' }
]
var optionalEnv = concat(
  empty(storageEndpoint) ? [] : [{ name: 'STORAGE_ENDPOINT', value: storageEndpoint }],
  mailDriver == 'smtp' ? [
    { name: 'SMTP_HOST', value: smtpHost }
    { name: 'SMTP_PORT', value: smtpPort }
    { name: 'SMTP_USER', value: smtpUser }
  ] : [],
  empty(smtpPassword) ? [] : [{ name: 'SMTP_PASSWORD', secretRef: 'smtp-password' }],
  empty(connectorEncryptionKey) ? [] : [{ name: 'CONNECTOR_ENCRYPTION_KEY', secretRef: 'connector-encryption-key' }],
  empty(connectorAwsAccessKeyId) ? [] : [
    { name: 'CONNECTOR_AWS_ACCESS_KEY_ID', secretRef: 'connector-aws-access-key-id' }
    { name: 'CONNECTOR_AWS_SECRET_ACCESS_KEY', secretRef: 'connector-aws-secret-access-key' }
  ]
)

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: appName
  location: location
  tags: tags
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: { '${pullIdentity.id}': {} }
  }
  dependsOn: [acrPull, pgDb, pgFirewall]
  properties: {
    managedEnvironmentId: env.id
    configuration: {
      activeRevisionsMode: 'Single'
      ingress: {
        external: true
        targetPort: 3000
        transport: 'auto'
        allowInsecure: false
      }
      registries: [
        {
          server: acr.properties.loginServer
          identity: pullIdentity.id
        }
      ]
      secrets: concat(baseSecrets, smtpSecrets, connectorSecrets)
    }
    template: {
      containers: [
        {
          name: 'portal'
          image: image
          resources: {
            cpu: json(cpu)
            memory: memory
          }
          env: concat(baseEnv, optionalEnv)
          probes: [
            {
              // Allows time for database migrations on the first start of a new version.
              type: 'Startup'
              httpGet: { path: '/api/v1/health/live', port: 3000 }
              initialDelaySeconds: 5
              periodSeconds: 5
              failureThreshold: 36
            }
            {
              type: 'Liveness'
              httpGet: { path: '/api/v1/health/live', port: 3000 }
              periodSeconds: 30
              failureThreshold: 3
            }
            {
              type: 'Readiness'
              httpGet: { path: '/api/v1/health/ready', port: 3000 }
              periodSeconds: 15
              failureThreshold: 4
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
        rules: [
          {
            name: 'http-concurrency'
            http: { metadata: { concurrentRequests: '50' } }
          }
        ]
      }
    }
  }
}

output portalUrl string = portalUrl
output appFqdn string = app.properties.configuration.ingress.fqdn
output containerAppName string = app.name
output environmentName string = env.name
output identityId string = pullIdentity.id
output postgresHost string = createDatabase ? pg.properties.fullyQualifiedDomainName : ''
