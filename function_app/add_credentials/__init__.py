import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing credential submission request...')
    if req.method == 'OPTIONS':
        # Handle CORS preflight
        return func.HttpResponse(
            '',
            status_code=204,
            headers={
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'POST, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        )
    if req.method != 'POST':
        return func.HttpResponse(
            json.dumps({'error': 'Method not allowed'}),
            status_code=405,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    try:
        data = req.get_json()
        customer_id = data.get('customer_id')
        provider = data.get('provider')
        if not customer_id or not provider:
            return func.HttpResponse(
                json.dumps({'error': 'customer_id and provider are required'}),
                status_code=400,
                mimetype='application/json',
                headers={"Access-Control-Allow-Origin": "*"}
            )
        # Prepare entity for Table Storage
        entity = {
            'PartitionKey': str(customer_id),
            'RowKey': str(provider)
        }
        for k, v in data.items():
            if k not in ['customer_id', 'provider']:
                entity[k] = v
        # Use environment variable for connection string
        table_conn_str = os.environ.get('AzureWebJobsStorage')
        if not table_conn_str:
            return func.HttpResponse(
                json.dumps({'error': 'AzureWebJobsStorage connection string not set'}),
                status_code=500,
                mimetype='application/json',
                headers={"Access-Control-Allow-Origin": "*"}
            )
        table_service = TableServiceClient.from_connection_string(table_conn_str)
        table_client = table_service.get_table_client('CloudCredentials')
        table_client.upsert_entity(entity)
        return func.HttpResponse(
            json.dumps({'success': True}),
            status_code=200,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logging.error(f'Error saving credentials: {str(e)}')
        return func.HttpResponse(
            json.dumps({'error': str(e)}),
            status_code=500,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        ) 