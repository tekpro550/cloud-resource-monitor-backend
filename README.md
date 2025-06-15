# Cloud Resource Monitor Backend

Azure Functions backend for monitoring cloud resources across multiple providers (AWS, Azure).

## Prerequisites

- Azure subscription
- Azure Key Vault for storing credentials
- Python 3.9 or later

## Configuration

1. Create an Azure Function App in the Azure Portal
2. Configure the following Application Settings in your Function App:
   - `AZURE_KEY_VAULT_NAME`: Your Azure Key Vault name
   - `AZURE_TENANT_ID`: Your Azure tenant ID
   - `AZURE_CLIENT_ID`: Your Azure client ID
   - `AZURE_CLIENT_SECRET`: Your Azure client secret

## Deployment

1. Connect your Azure Function App to this GitHub repository
2. Configure the following deployment settings:
   - Runtime stack: Python
   - Version: 3.9
   - Build configuration: Release

## API Endpoints

### GET /api/resources

Fetches cloud resources for a specific customer.

Query Parameters:
- `customer_id` (required): The ID of the customer
- `provider` (optional): Cloud provider to filter by ('aws', 'azure', or 'all')

Example Response:
```json
{
  "customer_id": "customer123",
  "resources": {
    "aws": {
      "ec2_instances": [...],
      "rds_instances": [...],
      "s3_buckets": [...],
      "lambda_functions": [...]
    },
    "azure": {
      "virtual_machines": [...],
      "storage_accounts": [...],
      "sql_databases": [...],
      "virtual_networks": [...]
    }
  }
}
```

## Local Development

1. Install Azure Functions Core Tools
2. Create a `local.settings.json` file with your configuration
3. Run `func start` to start the function app locally 