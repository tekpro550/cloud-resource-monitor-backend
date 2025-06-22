import logging
import json
import os
from datetime import datetime, timedelta
import azure.functions as func
import boto3
from azure.data.tables import TableServiceClient

# --- Helper function for AWS Lightsail ---
def get_lightsail_metrics(lightsail_client, instance_name):
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=1)
    
    metric_names = ["CPUUtilization", "NetworkIn", "NetworkOut", "StatusCheckFailed"]
    
    metrics_data = []

    for metric in metric_names:
        try:
            response = lightsail_client.get_instance_metric_data(
                instanceName=instance_name,
                metricName=metric,
                period=300,  # 5-minute intervals
                startTime=start_time,
                endTime=end_time,
                unit='Percent' if 'CPU' in metric else 'Bytes' if 'Network' in metric else 'Count',
                statistics=['Average', 'Sum']
            )
            metric_points = [
                {"timestamp": p['timestamp'].isoformat() + 'Z', "value": p.get('average', p.get('sum'))}
                for p in response['metricData']
            ]
            metrics_data.append({
                "name": metric,
                "unit": response['unit'],
                "data": metric_points
            })
        except Exception as e:
            logging.warning(f"Could not fetch metric '{metric}' for instance '{instance_name}'. Error: {e}")

    return metrics_data

# --- Main Function ---
def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for resource details.')

    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')
    resource_id = req.params.get('resource_id')
    region = req.params.get('region')

    if not all([customer_id, provider, resource_id, region]):
        return func.HttpResponse("Missing required parameters: customer_id, provider, resource_id, and region are required.", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key=provider, row_key=customer_id)

        metrics = []
        resource_name = ""

        if provider == 'aws':
            aws_access_key_id = credential_entity.get("access_key_id")
            aws_secret_access_key = credential_entity.get("secret_access_key")

            # Logic for Lightsail Instances
            if resource_id.startswith('arn:aws:lightsail:'):
                resource_name = resource_id.split('/')[-1]
                lightsail_client = boto3.client('lightsail', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                metrics = get_lightsail_metrics(lightsail_client, resource_name)
            
            # TODO: Add logic for EC2 instances using CloudWatch
            # elif resource_id.startswith('i-'):
            #     metrics = get_ec2_metrics(...)
            
            else:
                raise NotImplementedError(f"Metric fetching for AWS resource type with ID '{resource_id}' is not implemented.")

        # TODO: Add logic for other providers like 'azure', 'digitalocean'
        else:
            raise NotImplementedError(f"Metric fetching for provider '{provider}' is not implemented.")

        response_data = {
            "id": resource_id,
            "name": resource_name,
            "metrics": metrics
        }

        return func.HttpResponse(json.dumps(response_data, default=str), mimetype="application/json")

    except Exception as e:
        logging.error(f"Error fetching resource details: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 