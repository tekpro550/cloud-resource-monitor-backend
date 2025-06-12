import azure.functions as func
import json
import logging
from .fetch_resources import fetch_aws_resources, fetch_azure_resources, CloudResourceError
from .settings import load_environment

logger = logging.getLogger(__name__)

def main(req: func.HttpRequest) -> func.HttpResponse:
    try:
        # Load environment variables
        load_environment()
        
        # Get customer ID from query parameters
        customer_id = req.params.get('customer_id')
        if not customer_id:
            return func.HttpResponse(
                json.dumps({"error": "Customer ID is required"}),
                status_code=400,
                mimetype="application/json"
            )

        # Get cloud provider from query parameters (optional)
        cloud_provider = req.params.get('provider', 'all').lower()
        
        # Initialize response data
        response_data = {
            "customer_id": customer_id,
            "resources": {}
        }

        # Fetch resources based on provider
        if cloud_provider in ['all', 'aws']:
            try:
                response_data["resources"]["aws"] = fetch_aws_resources(customer_id)
            except CloudResourceError as e:
                response_data["resources"]["aws"] = {"error": str(e)}
                logger.error(f"AWS resource fetch error: {str(e)}")

        if cloud_provider in ['all', 'azure']:
            try:
                response_data["resources"]["azure"] = fetch_azure_resources(customer_id)
            except CloudResourceError as e:
                response_data["resources"]["azure"] = {"error": str(e)}
                logger.error(f"Azure resource fetch error: {str(e)}")

        # Return successful response
        return func.HttpResponse(
            json.dumps(response_data),
            status_code=200,
            mimetype="application/json"
        )

    except Exception as e:
        logger.error(f"Unexpected error: {str(e)}")
        return func.HttpResponse(
            json.dumps({
                "error": "Internal server error",
                "details": str(e)
            }),
            status_code=500,
            mimetype="application/json"
        )

