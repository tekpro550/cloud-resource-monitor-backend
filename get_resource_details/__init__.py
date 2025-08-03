import logging
import json
import os
from datetime import datetime, timedelta
import azure.functions as func
import boto3
from azure.data.tables import TableServiceClient
from azure.mgmt.monitor import MonitorManagementClient
from azure.identity import ClientSecretCredential
from botocore.exceptions import ClientError, NoCredentialsError

def get_lightsail_metrics(lightsail_client, instance_name):
    """Fetches key metrics for a given Lightsail instance."""
    end_time = datetime.utcnow()
    start_time = end_time - timedelta(hours=3)
    
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
                period=300,  # 5-minute intervals
                startTime=start_time,
                endTime=end_time,
                unit='Percent' if 'CPU' in metric_name else 'Bytes' if 'Network' in metric_name else 'Count'
            )
            
            metric_data = {
                "name": result['metricName'],
                "unit": result['unit'],
                "data": [
                    {
                        "timestamp": p['timestamp'].isoformat(), 
                        "value": p.get('average') or p.get('sum') or p.get('maximum') or 0
                    }
                    for p in result['metricData']
                    if p.get('average') is not None or p.get('sum') is not None or p.get('maximum') is not None
                ]
            }
            
            if metric_data["data"]:  # Only add if we have data
                metrics_response.append(metric_data)
                
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            logging.warning(f"AWS error fetching metric '{metric_name}' for instance '{instance_name}': {error_code} - {e}")
        except Exception as e:
            logging.warning(f"Could not fetch metric '{metric_name}' for instance '{instance_name}': {e}")
    
    return metrics_response

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
                "unit": "Percent" if "CPU" in metric_name else "Bytes",
                "data": [
                    {"timestamp": dp['Timestamp'].isoformat(), "value": dp['Average']}
                    for dp in sorted(result['Datapoints'], key=lambda x: x['Timestamp']) 
                    if 'Average' in dp
                ]
            }
            
            if metric_data["data"]:  # Only add if we have data
                metrics_response.append(metric_data)
                
        except ClientError as e:
            error_code = e.response.get('Error', {}).get('Code', 'Unknown')
            logging.warning(f"AWS error fetching EC2 metric '{metric_name}' for instance '{instance_id}': {error_code} - {e}")
        except Exception as e:
            logging.warning(f"Could not fetch EC2 metric '{metric_name}' for instance '{instance_id}': {e}")
    
    return metrics_response

def get_azure_metrics(monitor_client, resource_id):
    """Fetches key metrics for a given Azure resource."""
    try:
        # Determine metric names based on resource type
        if "virtualMachines" in resource_id:
            metric_names = "Percentage CPU,Network In,Network Out,Disk Read Bytes,Disk Write Bytes"
        elif "storageAccounts" in resource_id:
            metric_names = "UsedCapacity,Transactions"
        elif "databases" in resource_id:
            metric_names = "cpu_percent,connection_successful"
        else:
            metric_names = "Percentage CPU"
        
        metrics_data = monitor_client.metrics.list(
            resource_id,
            timespan="PT3H",  # Last 3 hours
            interval="PT5M",  # 5-minute intervals
            metricnames=metric_names,
            aggregation="Average"
        )
        
        metrics = []
        for item in metrics_data.value:
            metric_data = {
                "name": item.name.localized_value or item.name.value,
                "unit": str(item.unit),
                "data": []
            }
            
            for timeseries in item.timeseries:
                for data in timeseries.data:
                    if data.average is not None:
                        metric_data["data"].append({
                            "timestamp": data.time_stamp.isoformat(),
                            "value": data.average
                        })
            
            # Sort by timestamp
            metric_data["data"].sort(key=lambda x: x["timestamp"])
            
            if metric_data["data"]:  # Only add if we have data
                metrics.append(metric_data)
        
        return metrics
        
    except Exception as e:
        logging.error(f"Error fetching Azure metrics for {resource_id}: {e}")
        return []

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for resource details.')
    
    customer_id = req.params.get('customer_id')
    provider = req.params.get('provider')
    resource_id = req.params.get('resource_id')
    region = req.params.get('region')
    
    if not all([customer_id, provider, resource_id, region]):
        return func.HttpResponse(
            json.dumps({
                "error": "Missing required parameters",
                "required": ["customer_id", "provider", "resource_id", "region"]
            }),
            status_code=400,
            mimetype="application/json"
        )
    
    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        
        # Get credentials with proper error handling
        try:
            credential_entity = credentials_client.get_entity(partition_key=provider.lower(), row_key=customer_id)
        except Exception as e:
            logging.error(f"Failed to get credentials for customer {customer_id} and provider {provider}: {e}")
            return func.HttpResponse(
                json.dumps({
                    "error": "Authentication failed",
                    "message": f"Could not retrieve credentials for customer {customer_id} and provider {provider}"
                }),
                status_code=401,
                mimetype="application/json"
            )
        
        if provider.lower() == 'aws':
            aws_access_key_id = credential_entity.get("access_key_id")
            aws_secret_access_key = credential_entity.get("secret_access_key")
            
            if not aws_access_key_id or not aws_secret_access_key:
                return func.HttpResponse(
                    json.dumps({
                        "error": "AWS credentials incomplete",
                        "message": "Missing access_key_id or secret_access_key"
                    }),
                    status_code=401,
                    mimetype="application/json"
                )
            
            try:
                # Determine resource type and fetch appropriate metrics
                if resource_id.startswith('ls-') or 'lightsail' in resource_id.lower():
                    # Lightsail instance
                    lightsail_client = boto3.client(
                        'lightsail',
                        aws_access_key_id=aws_access_key_id,
                        aws_secret_access_key=aws_secret_access_key,
                        region_name=region
                    )
                    metrics = get_lightsail_metrics(lightsail_client, resource_id)
                    resource_type = 'lightsail'
                else:
                    # EC2 instance
                    cloudwatch_client = boto3.client(
                        'cloudwatch',
                        aws_access_key_id=aws_access_key_id,
                        aws_secret_access_key=aws_secret_access_key,
                        region_name=region
                    )
                    metrics = get_ec2_metrics(cloudwatch_client, resource_id, region)
                    resource_type = 'ec2'
                
                response_data = {
                    "id": resource_id,
                    "type": resource_type,
                    "metrics": metrics
                }
                
                if not metrics:
                    response_data["message"] = "No metrics found for this resource. This could be due to: 1) Resource is newly created, 2) Monitoring not enabled, 3) No recent activity"
                
                return func.HttpResponse(
                    json.dumps(response_data, default=str),
                    mimetype="application/json"
                )
                
            except NoCredentialsError:
                return func.HttpResponse(
                    json.dumps({
                        "error": "AWS authentication failed",
                        "message": "Invalid AWS credentials"
                    }),
                    status_code=401,
                    mimetype="application/json"
                )
            except ClientError as e:
                error_code = e.response.get('Error', {}).get('Code', 'Unknown')
                return func.HttpResponse(
                    json.dumps({
                        "error": f"AWS API error: {error_code}",
                        "message": str(e)
                    }),
                    status_code=401,
                    mimetype="application/json"
                )
        
        elif provider.lower() == 'azure':
            subscription_id = credential_entity.get("subscription_id")
            tenant_id = credential_entity.get("tenant_id")
            client_id = credential_entity.get("client_id")
            client_secret = credential_entity.get("client_secret")
            
            if not all([subscription_id, tenant_id, client_id, client_secret]):
                return func.HttpResponse(
                    json.dumps({
                        "error": "Azure credentials incomplete",
                        "message": "Missing subscription_id, tenant_id, client_id, or client_secret"
                    }),
                    status_code=401,
                    mimetype="application/json"
                )
            
            try:
                credential = ClientSecretCredential(
                    tenant_id=tenant_id,
                    client_id=client_id,
                    client_secret=client_secret
                )
                
                monitor_client = MonitorManagementClient(credential, subscription_id)
                metrics = get_azure_metrics(monitor_client, resource_id)
                
                response_data = {
                    "id": resource_id,
                    "type": "azure",
                    "metrics": metrics
                }
                
                if not metrics:
                    response_data["message"] = "No metrics found for this resource. This could be due to: 1) Resource is newly created, 2) Monitoring not enabled, 3) Insufficient permissions"
                
                return func.HttpResponse(
                    json.dumps(response_data, default=str),
                    mimetype="application/json"
                )
                
            except Exception as e:
                logging.error(f"Azure authentication/API error: {e}")
                return func.HttpResponse(
                    json.dumps({
                        "error": "Azure authentication failed",
                        "message": f"Failed to authenticate with Azure: {str(e)}"
                    }),
                    status_code=401,
                    mimetype="application/json"
                )
        
        else:
            return func.HttpResponse(
                json.dumps({
                    "error": "Unsupported provider",
                    "message": f"Metric fetching not implemented for provider: {provider}"
                }),
                status_code=400,
                mimetype="application/json"
            )
    
    except Exception as e:
        logging.error(f"Unexpected error fetching resource details: {e}", exc_info=True)
        return func.HttpResponse(
            json.dumps({
                "error": "Internal server error",
                "message": f"An unexpected error occurred: {str(e)}"
            }),
            status_code=500,
            mimetype="application/json"
        )

