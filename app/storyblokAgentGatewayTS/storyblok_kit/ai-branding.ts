import { resolveStoryblokSpaceId } from './storyblok-config.js';
import { callTool } from './gateway.js';

// The Storyblok MCP server doesn't expose AI Branding, so the Management API
// endpoint is published on the Gateway as its own OpenAPI target, SBMAPI
// (agentcore/gateway-targets/storyblok-mapi.openapi.json). Cedar allows this
// tool only for this deployment's space (allowStoryblokAiTools), and the
// Gateway attaches the PAT, so the runtime never handles the token for it.
const BRANDING_TOOL = 'SBMAPI___getAiBrandingRules';

/**
 * Fetch the space's AI Branding settings. The harness calls it once at session
 * start and puts the result in the space context.
 */
export async function getAiBrandingRules(): Promise<Record<string, unknown>> {
  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) throw new Error('Could not resolve the Storyblok space id.');
  const body = await callTool<{ ai_branding_rule?: Record<string, unknown> }>(
    BRANDING_TOOL,
    { space_id: spaceId },
    { retry: true },
  );
  return body.ai_branding_rule ?? {};
}
