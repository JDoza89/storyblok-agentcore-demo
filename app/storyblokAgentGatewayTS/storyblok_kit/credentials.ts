import { withApiKey } from 'bedrock-agentcore/identity';

import { awsRegion, createSigV4Fetch } from './sigv4.js';

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
/**
 * Read a credential straight out of the Secrets Manager secret that AgentCore
 * Identity keeps it in.
 *
 * The documented path -- withApiKey() falling back to
 * context.workloadAccessToken -- cannot work in this deployment. The SDK only
 * ever populates that token from an inbound `WorkloadAccessToken` header
 * (see bedrock-agentcore runtime/app.js), and AgentCore does not send one when
 * the runtime is invoked with SigV4/IAM -- which is how both `agentcore invoke`
 * and the FlowMotion HTTP node call it. Minting a token instead is refused:
 * GetWorkloadAccessToken answers "WorkloadIdentity is linked to a service and
 * cannot retrieve an access token by the caller". The result was that every
 * PAT-backed tool (fetchAiBrandingGuidelines, aiTranslateStory) failed in
 * deployment while working locally off the env var.
 *
 * So read the underlying secret directly with the execution role. Same value
 * AgentCore Identity would have handed back, minus the workload-identity hop
 * that SigV4 invocation cannot complete. STORYBLOK_PAT_SECRET_ID carries the
 * secret ARN; the execution role is granted GetSecretValue on exactly that one
 * secret in cdk-stack.ts.
 */
async function resolveFromSecretsManager(secretId: string): Promise<string | null> {
  const signedFetch = createSigV4Fetch({ service: 'secretsmanager' });
  const response = await signedFetch(`https://secretsmanager.${awsRegion()}.amazonaws.com/`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-amz-json-1.1',
      'x-amz-target': 'secretsmanager.GetSecretValue',
    },
    body: JSON.stringify({ SecretId: secretId }),
  });
  if (!response.ok) {
    throw new Error(`GetSecretValue returned HTTP ${response.status} ${response.statusText}`);
  }

  const { SecretString } = (await response.json()) as { SecretString?: string };
  if (!SecretString) return null;

  // AgentCore Identity stores an ApiKeyCredentialProvider value as
  // {"api_key_value": "..."}. Fall back to the raw string for a secret written
  // by hand as plain text.
  try {
    const parsed = JSON.parse(SecretString) as Record<string, unknown>;
    const value = parsed.api_key_value;
    return typeof value === 'string' && value ? value : null;
  } catch {
    return SecretString;
  }
}

export async function resolveCredential(
  providerName: string,
  localDevEnvVar: string,
): Promise<string | null> {
  const fromEnv = process.env[localDevEnvVar];
  if (fromEnv) return fromEnv;

  // Deployed path: read the secret directly. See resolveFromSecretsManager --
  // AgentCore Identity's own workload-token exchange cannot complete under
  // SigV4 invocation, so this is the path that actually works in the runtime.
  const secretId = process.env.STORYBLOK_PAT_SECRET_ID;
  if (secretId) {
    try {
      const fromSecret = await resolveFromSecretsManager(secretId);
      if (fromSecret) return fromSecret;
      console.warn(`Secret '${secretId}' held no usable value for '${providerName}'`);
    } catch (error) {
      console.warn(`Could not read secret '${secretId}' for '${providerName}': ${String(error)}`);
    }
  }

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

// Resolved once per container and reused. Only a successful resolution is
// cached, so a transient failure retries on the next call rather than
// poisoning every later request this process handles.
let cachedPat: string | null = null;

/**
 * Resolve the PAT up front and cache it, while still inside the request context.
 *
 * Must be called before the handler's first `yield`. The request context that
 * backs AgentCore Identity's workload-token exchange is carried in
 * AsyncLocalStorage, and that scope does not survive an async-generator
 * suspension: once `process` has yielded once, it resumes on the consumer's
 * context, so any later resolveStoryblokPat() sees no workloadAccessToken and
 * fails with "workloadIdentityToken not provided and no context available".
 *
 * Tool calls happen mid-stream, long after the first yield, which is why
 * fetchAiBrandingGuidelines and aiTranslateStory cannot resolve it themselves.
 */
export async function primeStoryblokPat(): Promise<void> {
  if (cachedPat === null) {
    cachedPat = await resolveCredential(
      STORYBLOK_PAT_CREDENTIAL_NAME,
      'AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT',
    );
  }
}

/**
 * Resolve the Storyblok Personal Access Token from AWS, never from source.
 *
 * Used by tools that call Storyblok's REST API directly rather than through the
 * Gateway MCP connection -- e.g. aiTranslateStory and fetchAiBrandingGuidelines,
 * which talk to Storyblok's Management API outside of MCP entirely. Those run
 * mid-stream, so they get the value primeStoryblokPat() cached during the
 * request; the direct call below is the local-dev / env-var path.
 */
export async function resolveStoryblokPat(): Promise<string | null> {
  if (cachedPat !== null) return cachedPat;
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
