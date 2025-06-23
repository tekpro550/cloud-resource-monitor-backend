import logging
import json
import os
from datetime import datetime, timedelta
import azure.functions as func
import boto3
from azure.data.tables import TableServiceClient
from azure.mgmt.monitor import MonitorManagementClient
from azure.identity import ClientSecretCredential

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

# --- Helper function for AWS EC2 ---
def get_ec2_metrics(cloudwatch_client, instance_id, region):
    """Fetches key metrics for a given EC2 instance."""
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=3)
    metric_names = [
        'CPUUtilization',
        'NetworkIn',
        'NetworkOut',
        'DiskReadBytes',
        'DiskWriteBytes'
    ]
    metrics_response = []
    for metric_name in metric_names:
        try:
            result = cloudwatch_client.get_metric_statistics(
                Namespace='AWS/EC2',
                MetricName=metric_name,
                Dimensions=[{'Name': 'InstanceId', 'Value': instance_id}],
                StartTime=start_time,
                EndTime=end_time,
                Period=300,
                Statistics=['Average']
            )
            metric_data = {
                "name": metric_name,
                "unit": result['Label'] if 'Label' in result else '',
                "data": [
                    {"timestamp": dp['Timestamp'].isoformat(), "value": dp['Average']}
                    for dp in sorted(result['Datapoints'], key=lambda x: x['Timestamp']) if 'Average' in dp
                ]
            }
            metrics_response.append(metric_data)
        except Exception as e:
            logging.warning(f"Could not fetch EC2 metric '{metric_name}' for instance '{instance_id}': {e}")
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
        if provider.lower() == 'aws':
            aws_access_key_id = credential_entity.get("access_key_id")
            aws_secret_access_key = credential_entity.get("secret_access_key")
            if not aws_access_key_id or not aws_secret_access_key:
                raise ValueError("AWS credentials not found or incomplete.")
            # Detect if resource_id is EC2 or Lightsail
            if resource_id.startswith('arn:aws:lightsail:') or resource_id.lower().startswith('lightsail'):
                # Assume Lightsail instance name is passed
                lightsail_client = boto3.client('lightsail', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                metrics = get_lightsail_metrics(lightsail_client, resource_id)
                resource_type = 'lightsail'
            else:
                # Assume EC2 instance ID is passed
                cloudwatch_client = boto3.client('cloudwatch', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                metrics = get_ec2_metrics(cloudwatch_client, resource_id, region)
                resource_type = 'ec2'
            response_data = {
                "id": resource_id,
                "type": resource_type,
                "metrics": metrics
            }
            if not metrics:
                response_data["message"] = "No metrics found for this resource. Please check if the resource exists, the metric is available, and permissions are correct."
            return func.HttpResponse(json.dumps(response_data, default=str), mimetype="application/json")
        elif provider.lower() == 'azure':
            subscription_id = credential_entity.get("subscription_id")
            tenant_id = credential_entity.get("tenant_id")
            client_id = credential_entity.get("client_id")
            client_secret = credential_entity.get("client_secret")
            if not all([subscription_id, tenant_id, client_id, client_secret]):
                raise ValueError("Azure credentials not found or incomplete.")
            credential = ClientSecretCredential(
                tenant_id=tenant_id,
                client_id=client_id,
                client_secret=client_secret
            )
            logging.info(f"Fetching metrics for Azure resource_id: {resource_id}")
            monitor_client = MonitorManagementClient(credential, subscription_id)
            try:
                metrics_data = monitor_client.metrics.list(
                    resource_id,
                    timespan="PT1H",
                    interval="PT5M",
                    metricnames="Percentage CPU",
                    aggregation="Average"
                )
                metrics = []
                for item in metrics_data.value:
                    metric = {
                        "name": item.name.localized_value,
                        "unit": item.unit,
                        "data": [
                            {"timestamp": data.time_stamp.isoformat(), "value": data.average}
                            for timeseries in item.timeseries for data in timeseries.data if data.average is not None
                        ]
                    }
                    metrics.append(metric)
                response_data = {
                    "id": resource_id,
                    "metrics": metrics
                }
                if not metrics:
                    response_data["message"] = "No metrics found for this resource. Please check if the resource exists, the metric is available, and permissions are correct."
                return func.HttpResponse(json.dumps(response_data, default=str), mimetype="application/json")
            except Exception as e:
                logging.error(f"Failed to fetch Azure metrics for {resource_id}: {e}", exc_info=True)
                return func.HttpResponse(f"Failed to fetch metrics: {str(e)}", status_code=401)
        else:
            return func.HttpResponse(f"Metric fetching not implemented for provider: {provider}", status_code=400)
    except Exception as e:
        logging.error(f"Error fetching resource details: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 