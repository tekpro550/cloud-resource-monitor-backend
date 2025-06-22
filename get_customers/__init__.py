import logging
import json
import os
import azure.functions as func
from azure.data.tables import TableServiceClient

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to get customers.')

    provider = req.route_params.get('provider')

    if not provider:
        return func.HttpResponse(
            "Please pass a provider in the URL.",
            status_code=400
        )

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        table_client = table_service_client.get_table_client(table_name="Credentials")

        filter_query = f"PartitionKey eq '{provider}'"
        entities = table_client.query_entities(query_filter=filter_query)

        customers = []
        for entity in entities:
            customers.append({
                "id": entity["RowKey"],
                "name": entity.get("customer_name", "N/A")
            })

        return func.HttpResponse(
            json.dumps(customers),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error getting customers: {e}")
        return func.HttpResponse(
             "An error occurred while fetching customer data.",
             status_code=500
        ) 