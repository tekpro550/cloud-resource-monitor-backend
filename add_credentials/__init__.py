import azure.functions as func
import json
import logging
from azure.data.tables import TableServiceClient, UpdateMode
import os

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to add credentials.')

    try:
        req_body = req.get_json()
    except ValueError:
        return func.HttpResponse("Invalid JSON format", status_code=400)

    customer_id = req_body.get('customer_id')
    customer_name = req_body.get('customer_name')
    provider = req_body.get('provider')

    if not all([customer_id, customer_name, provider]):
        return func.HttpResponse("Missing required fields: customer_id, customer_name, and provider are required.", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        table_client = table_service_client.get_table_client('CloudCredentials')

        entity = {
            "PartitionKey": provider,
            "RowKey": customer_id,
            "customer_name": customer_name
        }

        # Remove keys that are part of the entity key
        safe_body = req_body.copy()
        del safe_body['customer_id']
        del safe_body['customer_name']
        del safe_body['provider']

        # Add remaining fields from the request body
        entity.update(safe_body)

        table_client.upsert_entity(entity=entity, mode=UpdateMode.MERGE)

        return func.HttpResponse(
            json.dumps({"message": f"Credentials for customer {customer_id} ({customer_name}) saved successfully."}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error saving credentials: {e}")
        return func.HttpResponse(
             "An error occurred while saving the credentials.",
             status_code=500
        ) 