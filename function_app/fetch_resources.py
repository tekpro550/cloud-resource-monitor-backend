import boto3
from azure.identity import DefaultAzureCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.resource import ResourceManagementClient
from .settings import get_aws_credentials, get_azure_credentials

# Fetch AWS resources (EC2 instances, for example)
def fetch_aws_resources(customer_id):
    aws_credentials = get_aws_credentials(customer_id)
    ec2 = boto3.client(
        'ec2',
        aws_access_key_id=aws_credentials['aws_access_key'],
        aws_secret_access_key=aws_credentials['aws_secret_key'],
        region_name=aws_credentials['region']
    )
    
    # Fetch EC2 instances
    response = ec2.describe_instances()
    instances = []
    for reservation in response['Reservations']:
        for instance in reservation['Instances']:
            instances.append({
                'id': instance['InstanceId'],
                'state': instance['State']['Name'],
                'type': instance['InstanceType'],
                'region': aws_credentials['region']
            })
    return instances

# Fetch Azure resources (VMs, for example)
def fetch_azure_resources(customer_id):
    azure_credentials = get_azure_credentials(customer_id)
    credential = DefaultAzureCredential()
    compute_client = ComputeManagementClient(credential, azure_credentials['subscription_id'])

    # Fetch Virtual Machines
    vm_list = compute_client.virtual_machines.list_all()
    vms = []
    for vm in vm_list:
        vms.append({
            'id': vm.id,
            'name': vm.name,
            'location': vm.location,
            'status': vm.provisioning_state
        })
    return vms

