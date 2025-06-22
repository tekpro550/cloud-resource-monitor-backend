import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient, UpdateMode
import os
import boto3
from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient


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

def fetch_azure_resources(cred):
    try:
        credential = ClientSecretCredential(
            tenant_id=cred.get('TenantId'),
            client_id=cred.get('ClientId'),
            client_secret=cred.get('ClientSecret')
        )
        subscription_id = cred.get('SubscriptionId')
        compute_client = ComputeManagementClient(credential, subscription_id)
        vms = compute_client.virtual_machines.list_all()
        resources = []
        for vm in vms:
            resources.append({
                'name': vm.name,
                'provider': 'Azure',
                'type': 'VM',
                'status': 'unknown',  # You can fetch status with an extra call if needed
                'region': vm.location
            })
        return resources
    except Exception as e:
        logging.error(f"Azure fetch error: {e}")
        return []

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for AWS resources.')

    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        
        # Get credentials from CloudCredentials table
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key="aws", row_key=customer_id)

        aws_access_key_id = credential_entity.get("access_key_id")
        aws_secret_access_key = credential_entity.get("secret_access_key")
        aws_region = credential_entity.get("region", "us-east-1") # Default region if not specified

        if not aws_access_key_id or not aws_secret_access_key:
            raise ValueError("AWS credentials not found or incomplete for customer.")

        # Connect to AWS EC2
        ec2_client = boto3.client(
            'ec2',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=aws_region
        )

        response = ec2_client.describe_instances()

        resources = []
        for reservation in response["Reservations"]:
            for instance in reservation["Instances"]:
                instance_id = instance["InstanceId"]
                instance_type = instance["InstanceType"]
                status = instance["State"]["Name"]
                name_tag = next((tag['Value'] for tag in instance.get('Tags', []) if tag['Key'] == 'Name'), 'N/A')

                resource = {
                    "id": instance_id,
                    "name": name_tag,
                    "type": "EC2 Instance",
                    "region": aws_region,
                    "status": status,
                    "details": {
                        "instance_type": instance_type,
                        "private_ip": instance.get("PrivateIpAddress"),
                        "public_ip": instance.get("PublicIpAddress")
                    }
                }
                resources.append(resource)

                # Save to AwsResources table
                resources_client = table_service_client.get_table_client(table_name="AwsResources")
                resource_entity = {
                    "PartitionKey": customer_id,
                    "RowKey": instance_id,
                    "name": name_tag,
                    "type": "EC2 Instance",
                    "region": aws_region,
                    "status": status,
                    "instance_type": instance_type,
                    "private_ip": instance.get("PrivateIpAddress"),
                    "public_ip": instance.get("PublicIpAddress"),
                }
                resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
        
        return func.HttpResponse(
            json.dumps({"resources": resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching AWS resources: {e}")
        return func.HttpResponse(
             f"An error occurred while fetching AWS resources: {str(e)}",
             status_code=500
        ) 