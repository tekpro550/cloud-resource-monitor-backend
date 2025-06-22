import logging
import json
import os
import digitalocean
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for DigitalOcean resources.')

    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)

        # Get credentials from CloudCredentials table
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key="digitalocean", row_key=customer_id)

        token = credential_entity.get("personal_access_token")
        if not token:
            raise ValueError("DigitalOcean token not found for the customer.")

        manager = digitalocean.Manager(token=token)
        droplets = manager.get_all_droplets()

        resources = []
        resources_client = table_service_client.get_table_client(table_name="DigitalOceanResources")

        for droplet in droplets:
            resource = {
                "id": droplet.id,
                "name": droplet.name,
                "type": "Droplet",
                "region": droplet.region['slug'],
                "status": droplet.status,
                "details": {
                    "memory": droplet.memory,
                    "disk": droplet.disk,
                    "vcpus": droplet.vcpus
                }
            }
            resources.append(resource)

            # Save to DigitalOceanResources table
            resource_entity = {
                "PartitionKey": customer_id,
                "RowKey": str(droplet.id),
                "name": droplet.name,
                "type": "Droplet",
                "region": droplet.region['slug'],
                "status": droplet.status,
                "memory": droplet.memory,
                "disk": droplet.disk,
                "vcpus": droplet.vcpus
            }
            resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)

        return func.HttpResponse(
            json.dumps({"resources": resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching DigitalOcean resources: {e}")
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 