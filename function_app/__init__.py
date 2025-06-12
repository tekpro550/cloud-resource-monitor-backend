import azure.functions as func
from .fetch_resources import fetch_aws_resources, fetch_azure_resources
from .settings import load_environment

def main(req: func.HttpRequest) -> func.HttpResponse:
    load_environment()  # Load environment variables like API keys
    
    customer_id = req.params.get('customer_id')
    if not customer_id:
        return func.HttpResponse(
            "Customer ID is required.", status_code=400
        )

    # Call respective function to get resources
    try:
        aws_resources = fetch_aws_resources(customer_id)
        azure_resources = fetch_azure_resources(customer_id)
        all_resources = aws_resources + azure_resources
        
        return func.HttpResponse(
            f"Resources for customer {customer_id}: {all_resources}",
            status_code=200
        )
    except Exception as e:
        return func.HttpResponse(
            f"Error fetching resources: {str(e)}", status_code=500
        )

