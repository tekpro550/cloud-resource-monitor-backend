import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os
import boto3
from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient


def fetch_aws_resources(cred):
    try:
        session = boto3.Session(
            aws_access_key_id=cred.get('ClientId'),
            aws_secret_access_key=cred.get('ClientSecret'),
            aws_session_token=cred.get('SessionToken'),  # Optional
            region_name=cred.get('Region', 'us-east-1')
        )
        ec2 = session.resource('ec2')
        instances = ec2.instances.all()
        resources = []
        for inst in instances:
            resources.append({
                'name': inst.id,
                'provider': 'AWS',
                'type': 'EC2',
                'status': inst.state['Name'],
                'region': session.region_name
            })
        return resources
    except Exception as e:
        logging.error(f"AWS fetch error: {e}")
        return []

def fetch_azure_resources(cred):
    try:
        credential = ClientSecretCredential(
            tenant_id=cred.get('TenantId'),
            client_id=cred.get('ClientId'),
            client_secret=cred.get('ClientSecret')
        )
        subscription_id = cred.get('SubscriptionId')
        compute_client = ComputeManagementClient(credential, subscription_id)
        vms = compute_client.virtual_machines.list_all()
        resources = []
        for vm in vms:
            resources.append({
                'name': vm.name,
                'provider': 'Azure',
                'type': 'VM',
                'status': 'unknown',  # You can fetch status with an extra call if needed
                'region': vm.location
            })
        return resources
    except Exception as e:
        logging.error(f"Azure fetch error: {e}")
        return []

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing resource fetch request...')
    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')  # Optional

    if not customer_id:
        return func.HttpResponse(
            json.dumps({'error': 'customer_id is required'}),
            status_code=400,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )

    try:
        # Connect to Table Storage
        table_conn_str = os.environ.get('AzureWebJobsStorage')
        table_service = TableServiceClient.from_connection_string(table_conn_str)
        table_client = table_service.get_table_client('CloudCredentials')

        # Query for credentials for this customer
        filter_query = f"PartitionKey eq '{customer_id}'"
        if provider:
            filter_query += f" and RowKey eq '{provider}'"
        entities = list(table_client.query_entities(filter_query))

        all_resources = []
        for cred in entities:
            prov = cred.get('RowKey')
            if prov == 'AWS':
                all_resources.extend(fetch_aws_resources(cred))
            elif prov == 'Azure':
                all_resources.extend(fetch_azure_resources(cred))
            # Add more providers here as needed

        return func.HttpResponse(
            json.dumps({'resources': all_resources}),
            status_code=200,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logging.error(f'Error fetching resources: {str(e)}')
        return func.HttpResponse(
            json.dumps({'error': str(e)}),
            status_code=500,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        ) 