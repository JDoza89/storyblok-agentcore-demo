import logging

import httpx
from strands import tool

from storyblok_kit.credentials import resolve_storyblok_pat, resolve_storyblok_space_id

logger = logging.getLogger(__name__)

MANAGEMENT_API_BASE = "https://api-us.storyblok.com/v1"


@tool
def fetch_ai_branding_guidelines() -> str:
    """Fetch the space's real AI Branding settings (industry, product, audience,
    voice, and related fields) directly from Storyblok's Management API.

    Uses the agent's normal Storyblok credential (the same PAT resolved for
    every other Storyblok call), not a separate session token -- this is the
    real, durable source of truth, not a stopgap. If this fails, fall back to
    the story-based fetch described in the brand-guidelines skill.
    """
    token = resolve_storyblok_pat()
    if not token:
        return "Could not resolve the Storyblok credential -- cannot fetch AI Branding settings this way."

    space_id = resolve_storyblok_space_id()
    if space_id is None:
        return "Could not resolve the Storyblok space id -- cannot fetch AI Branding settings this way."

    try:
        response = httpx.get(
            f"{MANAGEMENT_API_BASE}/spaces/{space_id}/ai_branding_rules",
            headers={"Authorization": token},
            timeout=10.0,
        )
        response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("Failed to fetch AI Branding settings: %s", error)
        return (
            f"Failed to fetch AI Branding settings ({error}). Fall back to the "
            "guidelines story described in the brand-guidelines skill."
        )

    return response.json().get("ai_branding_rule", {})
