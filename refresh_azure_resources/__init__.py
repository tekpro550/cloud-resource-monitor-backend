import logging
import json
import os
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request to refresh Azure resources.')

    # Get customer_id from either query parameter (GET) or request body (POST)
    customer_id = req.params.get('customer_id')
    if not customer_id:
        try:
            req_body = req.get_json()
            customer_id = req_body.get('customer_id')
        except ValueError:
            pass  # No JSON body

    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string or in the request body", status_code=400)

    try:
        connect_str = os.environ["AzureWebJobsStorage"]
        table_service_client = TableServiceClient.from_connection_string(conn_str=connect_str)
        
        # Get credentials from CloudCredentials table
        credentials_client = table_service_client.get_table_client(table_name="CloudCredentials")
        credential_entity = credentials_client.get_entity(partition_key="azure", row_key=customer_id)

        subscription_id = credential_entity.get("subscription_id")
        tenant_id = credential_entity.get("tenant_id")
        client_id = credential_entity.get("client_id")
        client_secret = credential_entity.get("client_secret")

        if not all([subscription_id, tenant_id, client_id, client_secret]):
            raise ValueError("Azure credentials not found or incomplete for the customer.")

        # Authenticate with Azure
        credential = ClientSecretCredential(
            tenant_id=tenant_id,
            client_id=client_id,
            client_secret=client_secret
        )
        compute_client = ComputeManagementClient(credential, subscription_id)

        all_resources = []
        resources_client = table_service_client.get_table_client(table_name="AzureResources")

        for vm in compute_client.virtual_machines.list_all():
            resource_group = vm.id.split("/")[4]
            logging.info(f"Resource group for VM {vm.name}: {resource_group}")
            try:
                instance_view = compute_client.virtual_machines.instance_view(resource_group, vm.name)
                statuses = [s for s in instance_view.statuses if s.code.startswith('PowerState/')]
                status = statuses[0].display_status if statuses else "unknown"
            except Exception as e:
                logging.error(f"Failed to fetch instance_view for VM {vm.name}: {e}")
                status = "unknown"
            resource = {
                "id": vm.id,
                "name": vm.name,
                "type": "Virtual Machine",
                "region": vm.location,
                "status": status,
                "details": {"vm_size": vm.hardware_profile.vm_size}
            }
            all_resources.append(resource)
            resource_entity = {
                "PartitionKey": customer_id,
                "RowKey": vm.id.replace("/", "_"),
                "name": vm.name,
                "type": "Virtual Machine",
                "region": vm.location,
                "status": status,
                "vm_size": vm.hardware_profile.vm_size
            }
            resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
        
        return func.HttpResponse(
            json.dumps({"resources": all_resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching Azure resources: {e}", exc_info=True)
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 