import logging
import json
import os
from datetime import datetime
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import ClientSecretCredential
from azure.mgmt.monitor import MonitorManagementClient
import boto3

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to refresh metrics.')

    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')
    if not customer_id or not provider:
        return func.HttpResponse("Please pass customer_id and provider on the query string", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        metrics_client = table_service_client.get_table_client(table_name="ResourceMetrics")
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key=provider.lower(), row_key=customer_id)
        metrics_written = 0
        if provider.lower() == 'aws':
            aws_access_key_id = credential_entity.get("access_key_id")
            aws_secret_access_key = credential_entity.get("secret_access_key")
            if not aws_access_key_id or not aws_secret_access_key:
                raise ValueError("AWS credentials not found or incomplete.")
            # Fetch all EC2 and Lightsail resources for this customer
            resources_client = table_service_client.get_table_client(table_name="AwsResources")
            filter_query = f"PartitionKey eq '{customer_id}'"
            resources = list(resources_client.query_entities(filter_query))
            for resource in resources:
                region = resource.get("region")
                resource_id = resource.get("id")
                resource_type = resource.get("type", "").lower()
                if resource_type == "ec2 instance":
                    cloudwatch_client = boto3.client('cloudwatch', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                    # Only fetch CPUUtilization for demo; add more as needed
                    end_time = datetime.utcnow()
                    start_time = end_time.replace(minute=0, second=0, microsecond=0)
                    try:
                        result = cloudwatch_client.get_metric_statistics(
                            Namespace='AWS/EC2',
                            MetricName='CPUUtilization',
                            Dimensions=[{'Name': 'InstanceId', 'Value': resource_id}],
                            StartTime=start_time,
                            EndTime=end_time,
                            Period=300,
                            Statistics=['Average']
                        )
                        for dp in result['Datapoints']:
                            entity = {
                                "PartitionKey": customer_id,
                                "RowKey": f"aws_{resource_id}_CPUUtilization_{dp['Timestamp'].isoformat()}".replace(':', '_'),
                                "provider": "aws",
                                "resource_id": resource_id,
                                "metric_name": "CPUUtilization",
                                "value": dp['Average'],
                                "timestamp": dp['Timestamp'].isoformat(),
                                "region": region
                            }
                            metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                            metrics_written += 1
                    except Exception as e:
                        logging.warning(f"Failed to fetch EC2 metrics for {resource_id}: {e}")
                elif resource_type == "lightsail instance":
                    lightsail_client = boto3.client('lightsail', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                    try:
                        result = lightsail_client.get_instance_metric_data(
                            instanceName=resource.get("name"),
                            metricName='CPUUtilization',
                            period=300,
                            startTime=start_time,
                            endTime=end_time,
                            unit='Percent'
                        )
                        for dp in result['metricData']:
                            entity = {
                                "PartitionKey": customer_id,
                                "RowKey": f"aws_{resource_id}_CPUUtilization_{dp['timestamp'].isoformat()}".replace(':', '_'),
                                "provider": "aws",
                                "resource_id": resource_id,
                                "metric_name": "CPUUtilization",
                                "value": dp.get('average'),
                                "timestamp": dp['timestamp'].isoformat(),
                                "region": region
                            }
                            metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                            metrics_written += 1
                    except Exception as e:
                        logging.warning(f"Failed to fetch Lightsail metrics for {resource_id}: {e}")
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
            monitor_client = MonitorManagementClient(credential, subscription_id)
            resources_client = table_service_client.get_table_client(table_name="AzureResources")
            filter_query = f"PartitionKey eq '{customer_id}'"
            resources = list(resources_client.query_entities(filter_query))
            for resource in resources:
                resource_id = resource.get("id")
                region = resource.get("region")
                try:
                    metrics_data = monitor_client.metrics.list(
                        resource_id,
                        timespan="PT1H",
                        interval="PT5M",
                        metricnames="Percentage CPU",
                        aggregation="Average"
                    )
                    for item in metrics_data.value:
                        for timeseries in item.timeseries:
                            for data in timeseries.data:
                                if data.average is not None:
                                    entity = {
                                        "PartitionKey": customer_id,
                                        "RowKey": f"azure_{resource_id.replace('/', '_')}_PercentageCPU_{data.time_stamp.isoformat()}".replace(':', '_'),
                                        "provider": "azure",
                                        "resource_id": resource_id,
                                        "metric_name": "Percentage CPU",
                                        "value": data.average,
                                        "timestamp": data.time_stamp.isoformat(),
                                        "region": region
                                    }
                                    metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                                    metrics_written += 1
                except Exception as e:
                    logging.warning(f"Failed to fetch Azure metrics for {resource_id}: {e}")
        else:
            return func.HttpResponse(f"Provider {provider} not supported for metrics refresh.", status_code=400)
        return func.HttpResponse(json.dumps({"status": "success", "metrics_written": metrics_written}), status_code=200, mimetype="application/json")
    except Exception as e:
        logging.error(f"Error refreshing metrics: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 