import logging
import json
import os
import azure.functions as func
from azure.data.tables import TableServiceClient

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to list AWS resources from cache.')

    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        
        # Get all cached resources for this customer from the AwsResources table
        resources_client = table_service_client.get_table_client(table_name="AwsResources")
        filter_query = f"PartitionKey eq '{customer_id}'"
        
        cached_resources = list(resources_client.query_entities(filter_query))
        
        # Clean up the response to remove Azure-specific metadata
        for resource in cached_resources:
            del resource['PartitionKey']
            del resource['RowKey']
            del resource['odata.etag']
            
        return func.HttpResponse(
            json.dumps({"resources": cached_resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching cached AWS resources: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 