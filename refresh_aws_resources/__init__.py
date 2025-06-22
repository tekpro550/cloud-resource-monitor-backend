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

        if not aws_access_key_id or not aws_secret_access_key:
            raise ValueError("AWS credentials not found or incomplete for the customer.")

        # Get a list of all available AWS regions
        base_ec2_client = boto3.client('ec2', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name='us-east-1')
        available_regions = [region['RegionName'] for region in base_ec2_client.describe_regions()['Regions']]
        logging.info(f"Scanning {len(available_regions)} AWS regions.")

        all_resources = []
        resources_client = table_service_client.get_table_client(table_name="AwsResources")

        for region in available_regions:
            try:
                logging.info(f"Scanning region: {region}")
                
                # Create clients for the specific region
                ec2_client = boto3.client('ec2', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)
                lightsail_client = boto3.client('lightsail', aws_access_key_id=aws_access_key_id, aws_secret_access_key=aws_secret_access_key, region_name=region)

                # --- Fetch EC2 Instances ---
                ec2_response = ec2_client.describe_instances()
                for reservation in ec2_response["Reservations"]:
                    for instance in reservation["Instances"]:
                        instance_id = instance["InstanceId"]
                        name_tag = next((tag['Value'] for tag in instance.get('Tags', []) if tag['Key'] == 'Name'), instance_id)
                        resource = { "id": instance_id, "name": name_tag, "type": "EC2 Instance", "region": region, "status": instance["State"]["Name"], "details": { "instance_type": instance["InstanceType"] } }
                        all_resources.append(resource)
                        resource_entity = { "PartitionKey": customer_id, "RowKey": instance_id, "name": name_tag, "type": "EC2 Instance", "region": region, "status": instance["State"]["Name"], "instance_type": instance["InstanceType"] }
                        resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
                
                # --- Fetch Lightsail Instances ---
                lightsail_response = lightsail_client.get_instances()
                for instance in lightsail_response['instances']:
                    instance_arn = instance['arn']
                    resource = { "id": instance_arn, "name": instance['name'], "type": "Lightsail Instance", "region": instance['location']['regionName'], "status": instance['state']['name'], "details": { "blueprint": instance['blueprintName'] } }
                    all_resources.append(resource)
                    resource_entity = { "PartitionKey": customer_id, "RowKey": instance_arn.replace(":", "_").replace("/", "_"), "name": instance['name'], "type": "Lightsail Instance", "region": instance['location']['regionName'], "status": instance['state']['name'], "blueprint": instance['blueprintName'] }
                    resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
                    
            except Exception as region_error:
                logging.warning(f"Could not scan region {region}. It might be disabled for this account. Error: {str(region_error)}")

        return func.HttpResponse(
            json.dumps({"resources": all_resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching AWS resources: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 