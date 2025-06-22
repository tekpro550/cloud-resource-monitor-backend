import logging
import json
import os
from datetime import datetime, timedelta
import azure.functions as func
import boto3
from azure.data.tables import TableServiceClient

# --- Helper function for AWS Lightsail ---
def get_lightsail_metrics(lightsail_client, instance_name):
    """Fetches key metrics for a given Lightsail instance."""
    
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=3) # Get metrics for the last 3 hours
    
    metric_names = [
        'CPUUtilization',
        'NetworkIn',
        'NetworkOut',
        'StatusCheckFailed'
    ]
    
    metrics_response = []

    for metric_name in metric_names:
        try:
            result = lightsail_client.get_instance_metric_data(
                instanceName=instance_name,
                metricName=metric_name,
                period=300, # 5-minute intervals
                startTime=start_time,
                endTime=end_time,
                unit='Percent' if 'CPU' in metric_name else 'Bytes' if 'Network' in metric_name else 'Count'
            )
            
            metric_data = {
                "name": result['metricName'],
                "unit": result['unit'],
                "data": [
                    {"timestamp": p['timestamp'].isoformat(), "value": p['average'] if 'average' in p else p.get('sum')}
                    for p in result['metricData']
                ]
            }
            metrics_response.append(metric_data)
        except Exception as e:
            logging.warning(f"Could not fetch metric '{metric_name}' for instance '{instance_name}': {e}")

    return metrics_response

# --- Main Function ---
def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for resource details.')

    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')
    resource_id = req.params.get('resource_id')
    region = req.params.get('region')

    if not all([customer_id, provider, resource_id, region]):
        return func.HttpResponse("Missing required parameters: customer_id, provider, resource_id, region", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key=provider.lower(), row_key=customer_id)

        aws_access_key_id = credential_entity.get("access_key_id")
        aws_secret_access_key = credential_entity.get("secret_access_key")

        if not aws_access_key_id or not aws_secret_access_key:
            raise ValueError("AWS credentials not found or incomplete.")

        if provider.lower() == 'aws':
            # For now, we assume the resource is a Lightsail instance if we're getting details
            # The resource_id for lightsail is its name for this API call
            
            lightsail_client = boto3.client('lightsail', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
            
            # To get metrics, we need the instance *name*, not the full ARN.
            # The ARN is passed as resource_id, so we parse the name from it.
            # e.g., arn:aws:lightsail:eu-central-1:16188797438:Instance/a9553129-ffe6-4aaf-bae0-4468055c6c5a
            # The name is what comes after "Instance/" but that's not the user-visible name.
            # The user-visible name is passed in the list call, so we assume the frontend sends the user-visible name as resource_id
            
            metrics = get_lightsail_metrics(lightsail_client, resource_id)
            
            response_data = {
                "id": resource_id,
                "metrics": metrics
            }
            return func.HttpResponse(json.dumps(response_data, default=str), mimetype="application/json")
        
        else:
            return func.HttpResponse(f"Metric fetching not implemented for provider: {provider}", status_code=400)

    except Exception as e:
        logging.error(f"Error fetching resource details: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 