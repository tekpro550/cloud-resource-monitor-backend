import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os

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

        # For now, just return the credentials as a placeholder for resources
        # In production, use these credentials to fetch real resources from the cloud provider
        return func.HttpResponse(
            json.dumps({'resources': entities}),
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