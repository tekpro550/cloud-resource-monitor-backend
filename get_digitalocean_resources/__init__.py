import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os
import requests

def fetch_digitalocean_resources(cred):
    try:
        api_token = cred.get('ApiToken')
        if not api_token:
            return []
        headers = {
            'Authorization': f'Bearer {api_token}',
            'Content-Type': 'application/json'
        }
        resp = requests.get('https://api.digitalocean.com/v2/droplets', headers=headers)
        droplets = resp.json().get('droplets', [])
        resources = []
        for droplet in droplets:
            resources.append({
                'name': droplet['name'],
                'provider': 'DigitalOcean',
                'type': 'Droplet',
                'status': droplet['status'],
                'region': droplet['region']['slug']
            })
        return resources
    except Exception as e:
        logging.error(f"DigitalOcean fetch error: {e}")
        return []

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing DigitalOcean resource fetch request...')
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
        filter_query = f"PartitionKey eq '{customer_id}' and RowKey eq 'DigitalOcean'"
        entities = list(table_client.query_entities(filter_query))
        all_resources = []
        for cred in entities:
            all_resources.extend(fetch_digitalocean_resources(cred))
        return func.HttpResponse(
            json.dumps({'resources': all_resources}),
            status_code=200,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logging.error(f'Error fetching DigitalOcean resources: {str(e)}')
        return func.HttpResponse(
            json.dumps({'error': str(e)}),
            status_code=500,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        ) 