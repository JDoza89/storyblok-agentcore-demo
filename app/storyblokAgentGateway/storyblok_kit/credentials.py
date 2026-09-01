import os
import logging

logger = logging.getLogger(__name__)

STORYBLOK_PAT_CREDENTIAL_NAME = "storyblok-mcp-pat"

# Storyblok's Management API base per region -- not a uniform "api-{region}"
# pattern (EU and China are irregular), so this must stay an explicit map.
MANAGEMENT_API_BASE_BY_REGION = {
    "us": "https://api-us.storyblok.com/v1",
    "eu": "https://mapi.storyblok.com/v1",
    "ca": "https://api-ca.storyblok.com/v1",
    "ap": "https://api-ap.storyblok.com/v1",
    "cn": "https://app.storyblokchina.cn/v1",
}
DEFAULT_REGION = "us"


def resolve_credential(provider_name: str, local_dev_env_var: str) -> str | None:
    """Resolve a named secret credential: env var override for local dev, AgentCore Identity when deployed.

    Locally, 'agentcore dev' decrypts credentials into env vars. There's no such
    env var in the deployed runtime -- resolve it via AgentCore Identity's
    workload-token exchange instead. That token only exists in the per-request
    context (BedrockAgentCoreContext), so this must be called during request
    handling, never at module import time.

    Reserved for values that are genuine secrets (currently just the Storyblok
    PAT). Non-secret config (space id, region) doesn't need this -- it's just
    a plain environment variable, see resolve_storyblok_space_id/_region below.
    """
    token = os.environ.get(local_dev_env_var)
    if token:
        return token

    from bedrock_agentcore.runtime.context import BedrockAgentCoreContext
    from bedrock_agentcore.services.identity import IdentityClient

    workload_token = BedrockAgentCoreContext.get_workload_access_token()
    if not workload_token:
        logger.warning("No workload access token in context — '%s' unavailable", provider_name)
        return None

    region = os.environ.get("AWS_REGION", os.environ.get("AWS_DEFAULT_REGION", "us-east-1"))
    api_key = IdentityClient(region=region).dp_client.get_resource_api_key(
        resourceCredentialProviderName=provider_name,
        workloadIdentityToken=workload_token,
    ).get("apiKey")
    if not api_key:
        logger.warning(
            "AgentCore Identity returned no value for '%s' — unavailable",
            provider_name,
        )
        return None
    return api_key


def resolve_storyblok_pat() -> str | None:
    """Resolve the Storyblok Personal Access Token from AWS, never from source.

    Used by tools that call Storyblok's REST API directly rather than through
    the Gateway MCP connection -- e.g. ai_translate_story and
    fetch_ai_branding_guidelines, which talk to Storyblok's Management API
    outside of MCP entirely.
    """
    return resolve_credential(STORYBLOK_PAT_CREDENTIAL_NAME, "AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT")


def resolve_storyblok_space_id() -> int | None:
    """Resolve the single Storyblok space this deployment is allowed to touch.

    A plain STORYBLOK_SPACE_ID environment variable -- set in agentcore.json's
    runtime envVars when deployed, .env.local for local dev. Not a secret (it's
    just an id), so unlike the PAT it doesn't go through AgentCore Identity.
    """
    value = os.environ.get("STORYBLOK_SPACE_ID")
    if value is None:
        logger.warning("STORYBLOK_SPACE_ID is not set")
        return None
    try:
        return int(value)
    except ValueError:
        logger.warning("STORYBLOK_SPACE_ID %r is not a valid integer", value)
        return None


def resolve_storyblok_region() -> str:
    """Resolve this deployment's Storyblok region from the STORYBLOK_REGION
    environment variable (one of "us", "eu", "ca", "ap", "cn"), defaulting to
    "us" if unset. Not a secret, so a plain env var rather than AgentCore
    Identity -- same reasoning as resolve_storyblok_space_id above.
    """
    region = os.environ.get("STORYBLOK_REGION", DEFAULT_REGION).lower()
    if region not in MANAGEMENT_API_BASE_BY_REGION:
        logger.warning("Unknown STORYBLOK_REGION %r, falling back to %r", region, DEFAULT_REGION)
        return DEFAULT_REGION
    return region


def resolve_management_api_base() -> str:
    """Resolve the Storyblok Management API base URL for this deployment's region."""
    return MANAGEMENT_API_BASE_BY_REGION[resolve_storyblok_region()]
