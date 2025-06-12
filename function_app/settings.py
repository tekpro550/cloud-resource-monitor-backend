import os
from dotenv import load_dotenv

# Load environment variables
def load_environment():
    load_dotenv()

def get_aws_credentials(customer_id):
    # Retrieve customer-specific AWS credentials
    return {
        'aws_access_key': os.getenv(f'AWS_ACCESS_KEY_{customer_id}'),
        'aws_secret_key': os.getenv(f'AWS_SECRET_KEY_{customer_id}'),
        'region': os.getenv(f'AWS_REGION_{customer_id}')
    }

def get_azure_credentials(customer_id):
    # Retrieve customer-specific Azure credentials
    return {
        'subscription_id': os.getenv(f'AZURE_SUBSCRIPTION_ID_{customer_id}'),
        'tenant_id': os.getenv(f'AZURE_TENANT_ID_{customer_id}'),
        'client_id': os.getenv(f'AZURE_CLIENT_ID_{customer_id}'),
        'client_secret': os.getenv(f'AZURE_CLIENT_SECRET_{customer_id}')
    }

