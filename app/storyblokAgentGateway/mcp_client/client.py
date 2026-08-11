import os
import logging
from mcp.client.streamable_http import streamablehttp_client
from strands.tools.mcp.mcp_client import MCPClient

logger = logging.getLogger(__name__)

from mcp_proxy_for_aws.client import aws_iam_streamablehttp_client

def get_reinventdemogateway_mcp_client() -> MCPClient | None:
    """Returns an MCP Client connected to the reInventDemoGateway gateway."""
    url = os.environ.get("AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL")
    if not url:
        logger.warning("AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL not set — reInventDemoGateway gateway tools unavailable")
        return None
    return MCPClient(lambda: aws_iam_streamablehttp_client(url, aws_service="bedrock-agentcore", aws_region=os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION"))))

def get_all_gateway_mcp_clients() -> list[MCPClient]:
    """Returns MCP clients for all configured gateways."""
    clients = []
    client = get_reinventdemogateway_mcp_client()
    if client:
        clients.append(client)
    return clients
