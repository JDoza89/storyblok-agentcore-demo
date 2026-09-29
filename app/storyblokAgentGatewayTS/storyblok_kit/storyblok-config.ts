/**
 * This deployment's Storyblok space and region: plain environment variables
 * set in agentcore.json's runtime envVars (or .env.local for local dev).
 *
 * There are no credentials here. Every Storyblok call goes through the Gateway,
 * whose SBMCP and SBMAPI targets attach the PAT from AgentCore Identity
 * themselves, so the runtime never reads or holds the token.
 */

const REGIONS = ['us', 'eu', 'ca', 'ap', 'cn'] as const;
const DEFAULT_REGION = 'us';

/** The single Storyblok space this deployment may touch, or null if unset or invalid. */
export function resolveStoryblokSpaceId(): number | null {
  const value = process.env.STORYBLOK_SPACE_ID;
  if (value === undefined) {
    console.warn('STORYBLOK_SPACE_ID is not set');
    return null;
  }
  // Number() accepts "" and " " as 0, so reject anything that isn't all digits.
  if (!/^\d+$/.test(value.trim())) {
    console.warn(`STORYBLOK_SPACE_ID ${JSON.stringify(value)} is not a valid integer`);
    return null;
  }
  return Number(value.trim());
}

/** This deployment's Storyblok region, from STORYBLOK_REGION, defaulting to "us". */
export function resolveStoryblokRegion(): string {
  const region = (process.env.STORYBLOK_REGION ?? DEFAULT_REGION).toLowerCase();
  if (!(REGIONS as readonly string[]).includes(region)) {
    console.warn(`Unknown STORYBLOK_REGION ${JSON.stringify(region)}, falling back to "${DEFAULT_REGION}"`);
    return DEFAULT_REGION;
  }
  return region;
}
