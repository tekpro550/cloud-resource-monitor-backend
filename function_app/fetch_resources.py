import boto3
from azure.identity import DefaultAzureCredential
from azure.mgmt.compute import ComputeManagementClient
from azure.mgmt.resource import ResourceManagementClient
from azure.mgmt.storage import StorageManagementClient
from azure.mgmt.sql import SqlManagementClient
from azure.mgmt.network import NetworkManagementClient
from .settings import get_aws_credentials, get_azure_credentials
import logging

logger = logging.getLogger(__name__)

class CloudResourceError(Exception):
    """Custom exception for cloud resource fetching errors"""
    pass

# Fetch AWS resources (EC2 instances, for example)
def fetch_aws_resources(customer_id):
    try:
        aws_credentials = get_aws_credentials(customer_id)
        if not all(aws_credentials.values()):
            raise CloudResourceError("Missing AWS credentials")

        resources = {
            'ec2_instances': [],
            'rds_instances': [],
            's3_buckets': [],
            'lambda_functions': []
        }

        # Fetch EC2 instances
        ec2 = boto3.client('ec2', **aws_credentials)
        response = ec2.describe_instances()
        for reservation in response['Reservations']:
            for instance in reservation['Instances']:
                resources['ec2_instances'].append({
                    'id': instance['InstanceId'],
                    'state': instance['State']['Name'],
                    'type': instance['InstanceType'],
                    'region': aws_credentials['region'],
                    'tags': instance.get('Tags', [])
                })

        # Fetch RDS instances
        rds = boto3.client('rds', **aws_credentials)
        rds_instances = rds.describe_db_instances()
        for instance in rds_instances['DBInstances']:
            resources['rds_instances'].append({
                'id': instance['DBInstanceIdentifier'],
                'engine': instance['Engine'],
                'status': instance['DBInstanceStatus'],
                'size': instance['DBInstanceClass']
            })

        # Fetch S3 buckets
        s3 = boto3.client('s3', **aws_credentials)
        buckets = s3.list_buckets()
        for bucket in buckets['Buckets']:
            resources['s3_buckets'].append({
                'name': bucket['Name'],
                'creation_date': bucket['CreationDate'].isoformat()
            })

        # Fetch Lambda functions
        lambda_client = boto3.client('lambda', **aws_credentials)
        functions = lambda_client.list_functions()
        for function in functions['Functions']:
            resources['lambda_functions'].append({
                'name': function['FunctionName'],
                'runtime': function['Runtime'],
                'memory_size': function['MemorySize'],
                'timeout': function['Timeout']
            })

        return resources

    except Exception as e:
        logger.error(f"Error fetching AWS resources: {str(e)}")
        raise CloudResourceError(f"Failed to fetch AWS resources: {str(e)}")

# Fetch Azure resources (VMs, for example)
def fetch_azure_resources(customer_id):
    try:
        azure_credentials = get_azure_credentials(customer_id)
        if not all(azure_credentials.values()):
            raise CloudResourceError("Missing Azure credentials")

        credential = DefaultAzureCredential()
        subscription_id = azure_credentials['subscription_id']
        
        resources = {
            'virtual_machines': [],
            'storage_accounts': [],
            'sql_databases': [],
            'virtual_networks': []
        }

        # Fetch Virtual Machines
        compute_client = ComputeManagementClient(credential, subscription_id)
        vm_list = compute_client.virtual_machines.list_all()
        for vm in vm_list:
            resources['virtual_machines'].append({
                'id': vm.id,
                'name': vm.name,
                'location': vm.location,
                'status': vm.provisioning_state,
                'size': vm.hardware_profile.vm_size if vm.hardware_profile else None
            })

        # Fetch Storage Accounts
        storage_client = StorageManagementClient(credential, subscription_id)
        storage_accounts = storage_client.storage_accounts.list()
        for account in storage_accounts:
            resources['storage_accounts'].append({
                'id': account.id,
                'name': account.name,
                'location': account.location,
                'sku': account.sku.name,
                'kind': account.kind
            })

        # Fetch SQL Databases
        sql_client = SqlManagementClient(credential, subscription_id)
        servers = sql_client.servers.list()
        for server in servers:
            databases = sql_client.databases.list_by_server(server.resource_group, server.name)
            for db in databases:
                resources['sql_databases'].append({
                    'id': db.id,
                    'name': db.name,
                    'server': server.name,
                    'status': db.status,
                    'edition': db.edition
                })

        # Fetch Virtual Networks
        network_client = NetworkManagementClient(credential, subscription_id)
        vnets = network_client.virtual_networks.list_all()
        for vnet in vnets:
            resources['virtual_networks'].append({
                'id': vnet.id,
                'name': vnet.name,
                'location': vnet.location,
                'address_space': vnet.address_space.address_prefixes
            })

        return resources

    except Exception as e:
        logger.error(f"Error fetching Azure resources: {str(e)}")
        raise CloudResourceError(f"Failed to fetch Azure resources: {str(e)}")

