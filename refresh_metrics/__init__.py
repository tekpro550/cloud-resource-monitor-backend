import logging
import json
import os
from datetime import datetime, timedelta
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import ClientSecretCredential
from azure.mgmt.monitor import MonitorManagementClient
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to refresh metrics.')

    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')
    
    if not customer_id or not provider:
        return func.HttpResponse(
            json.dumps({"error": "Please pass customer_id and provider on the query string"}), 
            status_code=400, 
            mimetype="application/json"
        )

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        metrics_client = table_service_client.get_table_client(table_name="ResourceMetrics")
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        
        # Get credentials for the provider
        try:
            credential_entity = credentials_client.get_entity(partition_key=provider.lower(), row_key=customer_id)
        except Exception as e:
            logging.error(f"Failed to get credentials for customer {customer_id} and provider {provider}: {e}")
            return func.HttpResponse(
                json.dumps({"error": f"Credentials not found for customer {customer_id} and provider {provider}"}),
                status_code=404,
                mimetype="application/json"
            )
        
        metrics_written = 0
        
        if provider.lower() == 'aws':
            metrics_written = refresh_aws_metrics(customer_id, credential_entity, table_service_client, metrics_client)
        elif provider.lower() == 'azure':
            metrics_written = refresh_azure_metrics(customer_id, credential_entity, table_service_client, metrics_client)
        elif provider.lower() == 'digitalocean':
            metrics_written = refresh_digitalocean_metrics(customer_id, credential_entity, table_service_client, metrics_client)
        elif provider.lower() == 'alibaba':
            metrics_written = refresh_alibaba_metrics(customer_id, credential_entity, table_service_client, metrics_client)
        else:
            return func.HttpResponse(
                json.dumps({"error": f"Provider {provider} not supported for metrics refresh."}),
                status_code=400,
                mimetype="application/json"
            )
        
        return func.HttpResponse(
            json.dumps({"status": "success", "metrics_written": metrics_written}), 
            status_code=200, 
            mimetype="application/json"
        )
        
    except Exception as e:
        logging.error(f"Error refreshing metrics: {e}", exc_info=True)
        return func.HttpResponse(
            json.dumps({"error": f"An error occurred: {str(e)}"}),
            status_code=500,
            mimetype="application/json"
        )

def refresh_aws_metrics(customer_id, credential_entity, table_service_client, metrics_client):
    """Refresh AWS metrics for a customer"""
    metrics_written = 0
    
    aws_access_key_id = credential_entity.get("access_key_id")
    aws_secret_access_key = credential_entity.get("secret_access_key")
    
    if not aws_access_key_id or not aws_secret_access_key:
        raise ValueError("AWS credentials not found or incomplete.")
    
    # Fetch all AWS resources for this customer
    resources_client = table_service_client.get_table_client(table_name="AwsResources")
    filter_query = f"PartitionKey eq '{customer_id}'"
    resources = list(resources_client.query_entities(filter_query))
    
    # Set time range - last 2 hours to ensure we get data
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=2)
    
    for resource in resources:
        region = resource.get("region")
        resource_id = resource.get("id")
        resource_type = resource.get("type", "").lower()
        resource_name = resource.get("name", "")
        
        try:
            if "ec2" in resource_type or "instance" in resource_type:
                metrics_written += fetch_ec2_metrics(
                    aws_access_key_id, aws_secret_access_key, region,
                    resource_id, customer_id, start_time, end_time, metrics_client
                )
            elif "lightsail" in resource_type:
                metrics_written += fetch_lightsail_metrics(
                    aws_access_key_id, aws_secret_access_key, region,
                    resource_name, resource_id, customer_id, start_time, end_time, metrics_client
                )
            elif "rds" in resource_type:
                metrics_written += fetch_rds_metrics(
                    aws_access_key_id, aws_secret_access_key, region,
                    resource_id, customer_id, start_time, end_time, metrics_client
                )
        except Exception as e:
            logging.warning(f"Failed to fetch metrics for AWS resource {resource_id}: {e}")
    
    return metrics_written

def fetch_ec2_metrics(aws_access_key_id, aws_secret_access_key, region, instance_id, customer_id, start_time, end_time, metrics_client):
    """Fetch EC2 instance metrics"""
    metrics_written = 0
    
    try:
        cloudwatch_client = boto3.client(
            'cloudwatch',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=region
        )
        
        # Fetch multiple metrics for EC2
        metrics_to_fetch = ['CPUUtilization', 'NetworkIn', 'NetworkOut', 'DiskReadOps', 'DiskWriteOps']
        
        for metric_name in metrics_to_fetch:
            try:
                result = cloudwatch_client.get_metric_statistics(
                    Namespace='AWS/EC2',
                    MetricName=metric_name,
                    Dimensions=[{'Name': 'InstanceId', 'Value': instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=300,  # 5 minutes
                    Statistics=['Average', 'Maximum']
                )
                
                for dp in result.get('Datapoints', []):
                    # Store average value
                    if 'Average' in dp:
                        entity = {
                            "PartitionKey": customer_id,
                            "RowKey": f"aws_{instance_id}_{metric_name}_avg_{dp['Timestamp'].isoformat()}".replace(':', '_').replace('.', '_'),
                            "provider": "aws",
                            "resource_id": instance_id,
                            "metric_name": metric_name,
                            "value": dp['Average'],
                            "statistic": "Average",
                            "timestamp": dp['Timestamp'].isoformat(),
                            "region": region
                        }
                        metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                        metrics_written += 1
                    
                    # Store maximum value
                    if 'Maximum' in dp:
                        entity = {
                            "PartitionKey": customer_id,
                            "RowKey": f"aws_{instance_id}_{metric_name}_max_{dp['Timestamp'].isoformat()}".replace(':', '_').replace('.', '_'),
                            "provider": "aws",
                            "resource_id": instance_id,
                            "metric_name": metric_name,
                            "value": dp['Maximum'],
                            "statistic": "Maximum",
                            "timestamp": dp['Timestamp'].isoformat(),
                            "region": region
                        }
                        metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                        metrics_written += 1
                        
            except ClientError as e:
                logging.warning(f"Failed to fetch {metric_name} for EC2 instance {instance_id}: {e}")
                
    except Exception as e:
        logging.error(f"Error setting up CloudWatch client for region {region}: {e}")
        
    return metrics_written

def fetch_lightsail_metrics(aws_access_key_id, aws_secret_access_key, region, instance_name, resource_id, customer_id, start_time, end_time, metrics_client):
    """Fetch Lightsail instance metrics"""
    metrics_written = 0
    
    try:
        lightsail_client = boto3.client(
            'lightsail',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=region
        )
        
        metrics_to_fetch = ['CPUUtilization', 'NetworkIn', 'NetworkOut']
        
        for metric_name in metrics_to_fetch:
            try:
                result = lightsail_client.get_instance_metric_data(
                    instanceName=instance_name,
                    metricName=metric_name,
                    period=300,
                    startTime=start_time,
                    endTime=end_time,
                    unit='Percent' if metric_name == 'CPUUtilization' else 'Bytes'
                )
                
                for dp in result.get('metricData', []):
                    if dp.get('average') is not None:
                        entity = {
                            "PartitionKey": customer_id,
                            "RowKey": f"aws_{resource_id}_{metric_name}_{dp['timestamp'].isoformat()}".replace(':', '_').replace('.', '_'),
                            "provider": "aws",
                            "resource_id": resource_id,
                            "metric_name": metric_name,
                            "value": dp['average'],
                            "statistic": "Average",
                            "timestamp": dp['timestamp'].isoformat(),
                            "region": region
                        }
                        metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                        metrics_written += 1
                        
            except ClientError as e:
                logging.warning(f"Failed to fetch {metric_name} for Lightsail instance {instance_name}: {e}")
                
    except Exception as e:
        logging.error(f"Error setting up Lightsail client for region {region}: {e}")
        
    return metrics_written

def fetch_rds_metrics(aws_access_key_id, aws_secret_access_key, region, db_instance_id, customer_id, start_time, end_time, metrics_client):
    """Fetch RDS instance metrics"""
    metrics_written = 0
    
    try:
        cloudwatch_client = boto3.client(
            'cloudwatch',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=region
        )
        
        metrics_to_fetch = ['CPUUtilization', 'DatabaseConnections', 'FreeableMemory', 'ReadLatency', 'WriteLatency']
        
        for metric_name in metrics_to_fetch:
            try:
                result = cloudwatch_client.get_metric_statistics(
                    Namespace='AWS/RDS',
                    MetricName=metric_name,
                    Dimensions=[{'Name': 'DBInstanceIdentifier', 'Value': db_instance_id}],
                    StartTime=start_time,
                    EndTime=end_time,
                    Period=300,
                    Statistics=['Average']
                )
                
                for dp in result.get('Datapoints', []):
                    if 'Average' in dp:
                        entity = {
                            "PartitionKey": customer_id,
                            "RowKey": f"aws_{db_instance_id}_{metric_name}_{dp['Timestamp'].isoformat()}".replace(':', '_').replace('.', '_'),
                            "provider": "aws",
                            "resource_id": db_instance_id,
                            "metric_name": metric_name,
                            "value": dp['Average'],
                            "statistic": "Average",
                            "timestamp": dp['Timestamp'].isoformat(),
                            "region": region
                        }
                        metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                        metrics_written += 1
                        
            except ClientError as e:
                logging.warning(f"Failed to fetch {metric_name} for RDS instance {db_instance_id}: {e}")
                
    except Exception as e:
        logging.error(f"Error setting up CloudWatch client for RDS in region {region}: {e}")
        
    return metrics_written

def refresh_azure_metrics(customer_id, credential_entity, table_service_client, metrics_client):
    """Refresh Azure metrics for a customer"""
    metrics_written = 0
    
    subscription_id = credential_entity.get("subscription_id")
    tenant_id = credential_entity.get("tenant_id")
    client_id = credential_entity.get("client_id")
    client_secret = credential_entity.get("client_secret")
    
    if not all([subscription_id, tenant_id, client_id, client_secret]):
        raise ValueError("Azure credentials not found or incomplete.")
    
    try:
        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret
        )
        monitor_client = MonitorManagementClient(credential, subscription_id)
        
        # Fetch all Azure resources for this customer
        resources_client = table_service_client.get_table_client(table_name="AzureResources")
        filter_query = f"PartitionKey eq '{customer_id}'"
        resources = list(resources_client.query_entities(filter_query))
        
        for resource in resources:
            resource_id = resource.get("id")
            region = resource.get("region")
            resource_type = resource.get("type", "").lower()
            
            try:
                # Determine metrics to fetch based on resource type
                if "virtualmachine" in resource_type or "vm" in resource_type:
                    metric_names = "Percentage CPU,Network In,Network Out,Disk Read Bytes,Disk Write Bytes"
                elif "storage" in resource_type:
                    metric_names = "UsedCapacity,Transactions"
                elif "sql" in resource_type:
                    metric_names = "cpu_percent,connection_successful,blocked_by_firewall"
                else:
                    metric_names = "Percentage CPU"  # Default metric
                
                metrics_data = monitor_client.metrics.list(
                    resource_id,
                    timespan="PT2H",  # Last 2 hours
                    interval="PT5M",  # 5-minute intervals
                    metricnames=metric_names,
                    aggregation="Average,Maximum"
                )
                
                for item in metrics_data.value:
                    metric_name = item.name.value
                    for timeseries in item.timeseries:
                        for data in timeseries.data:
                            # Store average value
                            if data.average is not None:
                                entity = {
                                    "PartitionKey": customer_id,
                                    "RowKey": f"azure_{resource_id.replace('/', '_')}_avg_{metric_name}_{data.time_stamp.isoformat()}".replace(':', '_').replace('.', '_'),
                                    "provider": "azure",
                                    "resource_id": resource_id,
                                    "metric_name": metric_name,
                                    "value": data.average,
                                    "statistic": "Average",
                                    "timestamp": data.time_stamp.isoformat(),
                                    "region": region
                                }
                                metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                                metrics_written += 1
                            
                            # Store maximum value
                            if data.maximum is not None:
                                entity = {
                                    "PartitionKey": customer_id,
                                    "RowKey": f"azure_{resource_id.replace('/', '_')}_max_{metric_name}_{data.time_stamp.isoformat()}".replace(':', '_').replace('.', '_'),
                                    "provider": "azure",
                                    "resource_id": resource_id,
                                    "metric_name": metric_name,
                                    "value": data.maximum,
                                    "statistic": "Maximum",
                                    "timestamp": data.time_stamp.isoformat(),
                                    "region": region
                                }
                                metrics_client.upsert_entity(entity=entity, mode=UpdateMode.REPLACE)
                                metrics_written += 1
                                
            except Exception as e:
                logging.warning(f"Failed to fetch Azure metrics for {resource_id}: {e}")
                
    except Exception as e:
        logging.error(f"Error setting up Azure Monitor client: {e}")
        
    return metrics_written

def refresh_digitalocean_metrics(customer_id, credential_entity, table_service_client, metrics_client):
    """Refresh DigitalOcean metrics for a customer"""
    # DigitalOcean metrics implementation would go here
    # For now, return 0 as placeholder
    logging.info(f"DigitalOcean metrics refresh not yet implemented for customer {customer_id}")
    return 0

def refresh_alibaba_metrics(customer_id, credential_entity, table_service_client, metrics_client):
    """Refresh Alibaba Cloud metrics for a customer"""
    # Alibaba Cloud metrics implementation would go here
    # For now, return 0 as placeholder
    logging.info(f"Alibaba Cloud metrics refresh not yet implemented for customer {customer_id}")
    return 0

