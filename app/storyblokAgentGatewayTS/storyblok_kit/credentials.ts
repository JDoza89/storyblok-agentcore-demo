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

/**
 * Resolve a secret credential: the env var for local dev, otherwise the
 * Secrets Manager secret named by STORYBLOK_PAT_SECRET_ID. Returns null rather
 * than throwing, so the two tools that need it can report the gap.
 *
 * There is deliberately no AgentCore Identity (`withApiKey`) fallback. It needs
 * a workload access token that SigV4 invocation never supplies, so in this
 * deployment it could only ever fail.
 */
export async function resolveCredential(
  providerName: string,
  localDevEnvVar: string,
): Promise<string | null> {
  const fromEnv = process.env[localDevEnvVar];
  if (fromEnv) return fromEnv;

  const secretId = process.env.STORYBLOK_PAT_SECRET_ID;
  if (!secretId) {
    console.warn(`No ${localDevEnvVar} or STORYBLOK_PAT_SECRET_ID set -- '${providerName}' is unavailable`);
    return null;
  }
  try {
    const fromSecret = await resolveFromSecretsManager(secretId);
    if (fromSecret) return fromSecret;
    console.warn(`Secret '${secretId}' held no usable value for '${providerName}'`);
  } catch (error) {
    console.warn(`Could not read secret '${secretId}' for '${providerName}': ${String(error)}`);
  }
  return null;
}

// Resolved once per container and reused. Only a successful resolution is
// cached, so a transient failure retries on the next call rather than
// poisoning every later request this process handles.
let cachedPat: string | null = null;

/**
 * Resolve the PAT once per container at the start of a request and cache it,
 * so the branding fetch and every ai_translate_story call reuse one Secrets
 * Manager read instead of making their own.
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
 * Used only by the two calls the MCP server doesn't expose, AI branding and
 * ai_translate_story. Returns the value primeStoryblokPat() cached, or resolves
 * it now if nothing is cached yet (the verify script's path).
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
