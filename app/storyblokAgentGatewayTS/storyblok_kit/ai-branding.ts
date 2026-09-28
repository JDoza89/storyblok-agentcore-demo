import { resolveManagementApiBase, resolveStoryblokPat, resolveStoryblokSpaceId } from './credentials.js';

/**
 * Fetch the space's AI Branding settings straight from the Management API.
 *
 * One of the two Storyblok calls that don't go through the Gateway (the other
 * is `ai_translate_story`): the MCP server doesn't expose AI branding, so this
 * uses the PAT directly, exactly as v1's fetch_ai_branding_guidelines tool did.
 * The harness calls it once at session start and puts the result in the space
 * context.
 */
export async function getAiBrandingRules(): Promise<Record<string, unknown>> {
  const token = await resolveStoryblokPat();
  if (!token) throw new Error('Could not resolve the Storyblok credential.');
  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) throw new Error('Could not resolve the Storyblok space id.');

  const response = await fetch(`${resolveManagementApiBase()}/spaces/${spaceId}/ai_branding_rules`, {
    headers: { Authorization: token },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const body = (await response.json()) as { ai_branding_rule?: Record<string, unknown> };
  return body.ai_branding_rule ?? {};
}
