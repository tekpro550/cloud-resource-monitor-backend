import os
from dotenv import load_dotenv
from azure.keyvault.secrets import SecretClient
from azure.identity import DefaultAzureCredential
import logging

logger = logging.getLogger(__name__)

# Load environment variables
def load_environment():
    load_dotenv()
    
    # Verify required environment variables
    required_vars = [
        'AZURE_KEY_VAULT_NAME',
        'AZURE_TENANT_ID',
        'AZURE_CLIENT_ID',
        'AZURE_CLIENT_SECRET'
    ]
    
    missing_vars = [var for var in required_vars if not os.getenv(var)]
    if missing_vars:
        raise ValueError(f"Missing required environment variables: {', '.join(missing_vars)}")

def get_key_vault_client():
    """Get Azure Key Vault client for accessing secrets"""
    try:
        credential = DefaultAzureCredential()
        key_vault_name = os.getenv('AZURE_KEY_VAULT_NAME')
        key_vault_url = f"https://{key_vault_name}.vault.azure.net"
        return SecretClient(vault_url=key_vault_url, credential=credential)
    except Exception as e:
        logger.error(f"Failed to initialize Key Vault client: {str(e)}")
        raise

def get_aws_credentials(customer_id):
    """Retrieve customer-specific AWS credentials from Key Vault"""
    try:
        key_vault_client = get_key_vault_client()
        
        # Get secrets from Key Vault
        aws_access_key = key_vault_client.get_secret(f"aws-access-key-{customer_id}").value
        aws_secret_key = key_vault_client.get_secret(f"aws-secret-key-{customer_id}").value
        aws_region = key_vault_client.get_secret(f"aws-region-{customer_id}").value
        
        return {
            'aws_access_key_id': aws_access_key,
            'aws_secret_access_key': aws_secret_key,
            'region_name': aws_region
        }
    except Exception as e:
        logger.error(f"Failed to retrieve AWS credentials for customer {customer_id}: {str(e)}")
        # Fallback to environment variables for development
        return {
            'aws_access_key_id': os.getenv(f'AWS_ACCESS_KEY_{customer_id}'),
            'aws_secret_access_key': os.getenv(f'AWS_SECRET_KEY_{customer_id}'),
            'region_name': os.getenv(f'AWS_REGION_{customer_id}')
        }

def get_azure_credentials(customer_id):
    """Retrieve customer-specific Azure credentials from Key Vault"""
    try:
        key_vault_client = get_key_vault_client()
        
        # Get secrets from Key Vault
        subscription_id = key_vault_client.get_secret(f"azure-subscription-id-{customer_id}").value
        tenant_id = key_vault_client.get_secret(f"azure-tenant-id-{customer_id}").value
        client_id = key_vault_client.get_secret(f"azure-client-id-{customer_id}").value
        client_secret = key_vault_client.get_secret(f"azure-client-secret-{customer_id}").value
        
        return {
            'subscription_id': subscription_id,
            'tenant_id': tenant_id,
            'client_id': client_id,
            'client_secret': client_secret
        }
    except Exception as e:
        logger.error(f"Failed to retrieve Azure credentials for customer {customer_id}: {str(e)}")
        # Fallback to environment variables for development
        return {
            'subscription_id': os.getenv(f'AZURE_SUBSCRIPTION_ID_{customer_id}'),
            'tenant_id': os.getenv(f'AZURE_TENANT_ID_{customer_id}'),
            'client_id': os.getenv(f'AZURE_CLIENT_ID_{customer_id}'),
            'client_secret': os.getenv(f'AZURE_CLIENT_SECRET_{customer_id}')
        }

