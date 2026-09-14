import { withApiKey } from 'bedrock-agentcore/identity';

export const STORYBLOK_PAT_CREDENTIAL_NAME = 'storyblok-mcp-pat';

// Storyblok's Management API base per region -- not a uniform "api-{region}"
// pattern (EU and China are irregular), so this must stay an explicit map.
export const MANAGEMENT_API_BASE_BY_REGION: Record<string, string> = {
  us: 'https://api-us.storyblok.com/v1',
  eu: 'https://mapi.storyblok.com/v1',
  ca: 'https://api-ca.storyblok.com/v1',
  ap: 'https://api-ap.storyblok.com/v1',
  cn: 'https://app.storyblokchina.cn/v1',
};
export const DEFAULT_REGION = 'us';

/**
 * Resolve a named secret credential: env var override for local dev, AgentCore
 * Identity when deployed.
 *
 * Locally, `agentcore dev` decrypts credentials into env vars. There's no such
 * env var in the deployed runtime -- resolve it via AgentCore Identity's
 * workload-token exchange instead. `withApiKey` falls back to the request
 * context's workloadAccessToken, which only exists during request handling, so
 * this must be called from inside a request, never at module import time.
 *
 * Reserved for values that are genuine secrets (currently just the Storyblok
 * PAT). Non-secret config (space id, region) doesn't need this -- it's just a
 * plain environment variable, see resolveStoryblokSpaceId/Region below.
 */
export async function resolveCredential(
  providerName: string,
  localDevEnvVar: string,
): Promise<string | null> {
  const fromEnv = process.env[localDevEnvVar];
  if (fromEnv) return fromEnv;

  try {
    const readApiKey = withApiKey({ providerName })(async (apiKey: string) => apiKey);
    const apiKey = await readApiKey();
    if (!apiKey) {
      console.warn(`AgentCore Identity returned no value for '${providerName}' — unavailable`);
      return null;
    }
    return apiKey;
  } catch (error) {
    console.warn(`Could not resolve credential '${providerName}': ${String(error)}`);
    return null;
  }
}

/**
 * Resolve the Storyblok Personal Access Token from AWS, never from source.
 *
 * Used by tools that call Storyblok's REST API directly rather than through the
 * Gateway MCP connection -- e.g. aiTranslateStory and fetchAiBrandingGuidelines,
 * which talk to Storyblok's Management API outside of MCP entirely.
 */
export async function resolveStoryblokPat(): Promise<string | null> {
  return resolveCredential(STORYBLOK_PAT_CREDENTIAL_NAME, 'AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT');
}

/**
 * Resolve the single Storyblok space this deployment is allowed to touch.
 *
 * A plain STORYBLOK_SPACE_ID environment variable -- set in agentcore.json's
 * runtime envVars when deployed, .env.local for local dev. Not a secret (it's
 * just an id), so unlike the PAT it doesn't go through AgentCore Identity.
 */
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

/**
 * Resolve this deployment's Storyblok region from the STORYBLOK_REGION
 * environment variable (one of "us", "eu", "ca", "ap", "cn"), defaulting to
 * "us" if unset. Not a secret, so a plain env var rather than AgentCore
 * Identity -- same reasoning as resolveStoryblokSpaceId above.
 */
export function resolveStoryblokRegion(): string {
  const region = (process.env.STORYBLOK_REGION ?? DEFAULT_REGION).toLowerCase();
  if (!(region in MANAGEMENT_API_BASE_BY_REGION)) {
    console.warn(`Unknown STORYBLOK_REGION ${JSON.stringify(region)}, falling back to "${DEFAULT_REGION}"`);
    return DEFAULT_REGION;
  }
  return region;
}

/** Resolve the Storyblok Management API base URL for this deployment's region. */
export function resolveManagementApiBase(): string {
  return MANAGEMENT_API_BASE_BY_REGION[resolveStoryblokRegion()]!;
}
