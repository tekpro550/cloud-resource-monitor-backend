import logging
import json
import os
import azure.functions as func
from azure.data.tables import TableServiceClient, UpdateMode
from azure.identity import ClientSecretCredential
from azure.mgmt.compute import ComputeManagementClient

def main(req: func.HttpRequest) -> func.HttpResponse:
    logging.info('Python HTTP trigger function processed a request for Azure resources.')

    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse("Please pass a customer_id on the query string", status_code=400)

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

        resources = []
        resources_client = table_service_client.get_table_client(table_name="AzureResources")

        for vm in compute_client.virtual_machines.list_all():
            status = "unknown"
            # Getting instance view to find the status is an extra call per VM
            # vm_view = compute_client.virtual_machines.instance_view(vm.id.split('/')[4], vm.name)
            # statuses = [s for s in vm_view.statuses if s.code.startswith('PowerState/')]
            # if statuses:
            #     status = statuses[0].display_status

            resource = {
                "id": vm.id,
                "name": vm.name,
                "type": "Virtual Machine",
                "region": vm.location,
                "status": status,
                "details": {"vm_size": vm.hardware_profile.vm_size}
            }
            resources.append(resource)

            # Save to AzureResources table
            resource_entity = {
                "PartitionKey": customer_id,
                "RowKey": vm.id.replace("/", "_"), # RowKey can't have slashes
                "name": vm.name,
                "type": "Virtual Machine",
                "region": vm.location,
                "status": status,
                "vm_size": vm.hardware_profile.vm_size
            }
            resources_client.upsert_entity(entity=resource_entity, mode=UpdateMode.MERGE)
            
        return func.HttpResponse(
            json.dumps({"resources": resources}),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logging.error(f"Error fetching Azure resources: {e}")
        return func.HttpResponse(f"An error occurred: {str(e)}", status_code=500) 