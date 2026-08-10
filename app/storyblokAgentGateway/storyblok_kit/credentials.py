import os
import logging

logger = logging.getLogger(__name__)

STORYBLOK_SPACE_ID_CREDENTIAL_NAME = "storyblok-space-id"
STORYBLOK_REGION_CREDENTIAL_NAME = "storyblok-region"
STORYBLOK_PAT_CREDENTIAL_NAME = "storyblok-mcp-pat"


def resolve_credential(provider_name: str, local_dev_env_var: str) -> str | None:
    """Resolve a named credential: env var override for local dev, AgentCore Identity when deployed.

    Locally, 'agentcore dev' decrypts credentials into env vars. There's no such
    env var in the deployed runtime -- resolve it via AgentCore Identity's
    workload-token exchange instead. That token only exists in the per-request
    context (BedrockAgentCoreContext), so this must be called during request
    handling, never at module import time.

    Nothing here is Storyblok-specific: any config value a deployment wants to
    keep out of source (a credential, an id, a region) can go through this
    same path by registering it as an ApiKeyCredentialProvider under its own
    name. That's what makes the tools built on top of this reusable across
    agents/deployments without editing code -- a new deployment just points
    provider_name at its own credential provider.
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
    """Resolve the single Storyblok space this deployment is allowed to touch, from AWS.

    Deliberately resolved the same way as the PAT (a named credential, not a
    hardcoded literal) so a different deployment can point every tool and the
    SpaceIdGuard hook at a different space without changing a line of code --
    just register a different value under this same credential provider name.
    """
    value = resolve_credential(STORYBLOK_SPACE_ID_CREDENTIAL_NAME, "AGENTCORE_CREDENTIAL_STORYBLOK_SPACE_ID")
    if value is None:
        return None
    try:
        return int(value)
    except ValueError:
        logger.warning("Resolved space id %r is not a valid integer", value)
        return None
