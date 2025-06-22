import logging
import json
import os
import boto3
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode

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
        aws_region = credential_entity.get("region", "us-east-1") 

        if not aws_access_key_id or not aws_secret_access_key:
            raise ValueError("AWS credentials not found or incomplete for the customer.")

        # Connect to AWS EC2
        ec2_client = boto3.client(
            'ec2',
            aws_access_key_id=aws_access_key_id,
            aws_secret_access_key=aws_secret_access_key,
            region_name=aws_region
        )

        response = ec2_client.describe_instances()

        resources = []
        resources_client = table_service_client.get_table_client(table_name="AwsResources")

        for reservation in response["Reservations"]:
            for instance in reservation["Instances"]:
                instance_id = instance["InstanceId"]
                instance_type = instance["InstanceType"]
                status = instance["State"]["Name"]
                name_tag = next((tag['Value'] for tag in instance.get('Tags', []) if tag['Key'] == 'Name'), instance_id)

                resource = {
                    "id": instance_id,
                    "name": name_tag,
                    "type": "EC2 Instance",
                    "region": aws_region,
                    "status": status,
                    "details": { "instance_type": instance_type }
                }
                resources.append(resource)

                # Save to AwsResources table
                resource_entity = {
                    "PartitionKey": customer_id,
                    "RowKey": instance_id,
                    "name": name_tag,
                    "type": "EC2 Instance",
                    "region": aws_region,
                    "status": status,
                    "instance_type": instance_type,
                }
                resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
        
        return func.HttpResponse(
            json.dumps({"resources": resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching AWS resources: {e}")
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 