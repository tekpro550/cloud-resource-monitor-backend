import logging
import json
import os
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode
from alibabacloud_ecs20140526.client import Client as EcsClient
from alibabacloud_tea_openapi import models as open_api_models
from alibabacloud_ecs20140526 import models as ecs_models

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for Alibaba Cloud resources.')

    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)

        # Get credentials from CloudCredentials table
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key="alibaba", row_key=customer_id)

        access_key_id = credential_entity.get("access_key_id")
        access_key_secret = credential_entity.get("access_key_secret")
        region_id = credential_entity.get("region", "cn-hangzhou")

        if not access_key_id or not access_key_secret:
            raise ValueError("Alibaba Cloud credentials not found or incomplete for the customer.")

        # Configure Alibaba Cloud client
        config = open_api_models.Config(
            access_key_id=access_key_id,
            access_key_secret=access_key_secret,
            region_id=region_id
        )
        ecs_client = EcsClient(config)
        
        request = ecs_models.DescribeInstancesRequest(region_id=region_id)
        response = ecs_client.describe_instances(request)

        resources = []
        resources_client = table_service_client.get_table_client(table_name="AlibabaResources")

        for instance in response.body.instances.instance:
            resource = {
                "id": instance.instance_id,
                "name": instance.instance_name,
                "type": "ECS Instance",
                "region": instance.region_id,
                "status": instance.status,
                "details": {"instance_type": instance.instance_type}
            }
            resources.append(resource)

            # Save to AlibabaResources table
            resource_entity = {
                "PartitionKey": customer_id,
                "RowKey": instance.instance_id,
                "name": instance.instance_name,
                "type": "ECS Instance",
                "region": instance.region_id,
                "status": instance.status,
                "instance_type": instance.instance_type,
            }
            resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
            
        return func.HttpResponse(
            json.dumps({"resources": resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching Alibaba Cloud resources: {e}")
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 