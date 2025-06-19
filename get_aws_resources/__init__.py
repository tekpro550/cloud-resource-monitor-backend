import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient
import os
import boto3

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

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Processing AWS resource fetch request...')
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
        filter_query = f"PartitionKey eq '{customer_id}' and RowKey eq 'aws'"
        entities = list(table_client.query_entities(filter_query))
        all_resources = []
        for cred in entities:
            all_resources.extend(fetch_aws_resources(cred))
        return func.HttpResponse(
            json.dumps({'resources': all_resources}),
            status_code=200,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        )
    except Exception as e:
        logging.error(f'Error fetching AWS resources: {str(e)}')
        return func.HttpResponse(
            json.dumps({'error': str(e)}),
            status_code=500,
            mimetype='application/json',
            headers={"Access-Control-Allow-Origin": "*"}
        ) 