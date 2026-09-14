import { Sha256 } from '@aws-crypto/sha256-js';
import { defaultProvider } from '@aws-sdk/credential-provider-node';
import { SignatureV4 } from '@aws-sdk/signature-v4';
import { HttpRequest } from '@smithy/protocol-http';

/** The AWS region this deployment signs requests for. */
export function awsRegion(): string {
  return process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION ?? 'us-east-1';
}

export interface SigV4FetchOptions {
  service: string;
  region?: string;
  /**
   * S3 requires the canonical URI to be encoded exactly once, so callers
   * passing an already-encoded path must set this to false. Every other service
   * wants the signer's default double-encoding.
   */
  uriEscapePath?: boolean;
}

export type SignedFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

/**
 * Build a `fetch` that SigV4-signs every request with the execution role's
 * credentials.
 *
 * The Python agent gets gateway signing from `mcp-proxy-for-aws` and S3 from
 * boto3; neither has a TypeScript equivalent available here, so both go through
 * this one signer. Signing per request (rather than once at construction)
 * matters because a single caller reuses it across different methods, paths,
 * and bodies, each of which needs its own signature.
 */
export function createSigV4Fetch(options: SigV4FetchOptions): SignedFetch {
  const signer = new SignatureV4({
    service: options.service,
    region: options.region ?? awsRegion(),
    credentials: defaultProvider(),
    sha256: Sha256,
    applyChecksum: true,
    ...(options.uriEscapePath === undefined ? {} : { uriEscapePath: options.uriEscapePath }),
  });

  return async (input, init) => {
    const url = new URL(input.toString());
    const method = (init?.method ?? 'GET').toUpperCase();
    // Sign the body only when it is a string; callers here always send JSON
    // text or nothing, and a stream body could not be hashed without consuming it.
    const body = typeof init?.body === 'string' ? init.body : undefined;

    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((value, key) => {
      headers[key] = value;
    });
    headers.host = url.host;

    const signed = await signer.sign(
      new HttpRequest({
        method,
        protocol: url.protocol,
        hostname: url.hostname,
        ...(url.port ? { port: Number(url.port) } : {}),
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        ...(body === undefined ? {} : { body }),
      }),
    );

    // undici sets Host itself from the URL, to the same value we signed.
    // Passing it through explicitly is rejected as a forbidden header.
    const outgoing = { ...signed.headers };
    delete outgoing.host;

    return fetch(url, { ...init, method, headers: outgoing });
  };
}
