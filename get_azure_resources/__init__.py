import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os
from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient

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
                'status': 'unknown',
                'region': vm.location
            })
        return resources
    except Exception as e:
        logging.error(f"Azure fetch error: {e}")
        return []

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing Azure resource fetch request...')
    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse(
            json.dumps({'error': 'customer_id is required'}),
            status_code=400,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    try:
        table_conn_str = os.environ.get('AzureWebJobsStorage')
        table_service = TableServiceClient.from_connection_string(table_conn_str)
        table_client = table_service.get_table_client('CloudCredentials')
        filter_query = f"PartitionKey eq '{customer_id}' and RowKey eq 'azure'"
        entities = list(table_client.query_entities(filter_query))
        logging.info(f"Entities found: {len(entities)}")
        if not entities:
            logging.error(f'No credentials found for customer_id={customer_id} and provider=Azure')
            return func.HttpResponse(
                json.dumps({'error': 'No credentials found for this customer/provider'}),
                status_code=404,
                mimetype='application/json',
                headers={"Access-Control-Allow-Origin": "*"}
            )
        all_resources = []
        for cred in entities:
            all_resources.extend(fetch_azure_resources(cred))
        return func.HttpResponse(
            json.dumps({'resources': all_resources}),
            status_code=200,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logging.error(f'Error fetching Azure resources: {str(e)}', exc_info=True)
        return func.HttpResponse(
            json.dumps({'error': str(e)}),
            status_code=500,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        ) 