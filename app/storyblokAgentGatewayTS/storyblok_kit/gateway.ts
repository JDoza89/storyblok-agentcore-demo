import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';

import { resolveStoryblokSpaceId } from './credentials.js';
import { createSigV4Fetch } from './sigv4.js';

/**
 * The harness's own connection to the Gateway's Storyblok MCP target: the same
 * tools the model calls, called from code. Cedar authorizes every call exactly
 * as it does the model's, and the results come back to code, so none of them
 * enter the model's conversation.
 */

export class GatewayCallError extends Error {}

// The Gateway namespaces the Storyblok MCP server's tools under its target name.
export const READONLY_TOOL = 'SBMCP___execute_readonly';
export const MUTATING_TOOL = 'SBMCP___execute_mutating';

let connection: Promise<Client> | null = null;

/**
 * One MCP connection per process, opened on first use. First use is always
 * inside request handling (session setup), never at module import, which is
 * the ordering that tripped up v1's Gateway client.
 */
function connect(): Promise<Client> {
  if (!connection) {
    connection = (async () => {
      const url = process.env.AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL;
      if (!url) throw new GatewayCallError('AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL is not set.');
      const client = new Client({ name: 'storyblok-harness', version: '1.0.0' });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(url), {
          fetch: createSigV4Fetch({ service: 'bedrock-agentcore' }),
        }),
      );
      return client;
    })();
    // A failed connect must not poison every later call in this process.
    connection.catch(() => {
      connection = null;
    });
  }
  return connection;
}

function resultText(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] }).content ?? [];
  return content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
}

async function callOnce(tool: string, operation: string, args: Record<string, unknown>): Promise<unknown> {
  const client = await connect();
  const result = await client.callTool({ name: tool, arguments: args });
  const text = resultText(result);
  if ((result as { isError?: boolean }).isError) {
    throw new GatewayCallError(`${operation} failed through the Gateway: ${text}`);
  }
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw new GatewayCallError(`${operation} returned a non-JSON response: ${text.slice(0, 300)}`);
  }
  // The Storyblok MCP server reports API failures as a successful tool result
  // carrying `{"success": false, ...}`, so check the body, not just isError.
  if ((body as { success?: unknown }).success === false) {
    throw new GatewayCallError(`${operation} failed: ${text.slice(0, 300)}`);
  }
  return body;
}

/**
 * Call one Storyblok operation through the Gateway and return its body.
 * Paginated operations wrap their payload as `{ pagination, data }`; the rest
 * return it bare.
 *
 * `retry` reruns the call once on a fresh connection after a transport failure,
 * since a Gateway MCP session can expire between the calls a long run makes.
 * Only reads should set it: a write that failed in transit may still have
 * landed, and retrying it could apply it twice. An MCP-level error (a Cedar
 * denial, a bad operation) is never retried, because it's an answer rather than
 * a dropped connection.
 */
export async function callGateway<T>(options: {
  tool: string;
  operation: string;
  parameters?: Record<string, unknown>;
  fields?: string[];
  retry?: boolean;
}): Promise<T> {
  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) throw new GatewayCallError('Could not resolve the Storyblok space id.');
  const { tool, operation, fields } = options;
  const args = {
    operation,
    parameters: { space_id: spaceId, ...(options.parameters ?? {}) },
    ...(fields ? { fields } : {}),
  };

  let body: unknown;
  try {
    body = await callOnce(tool, operation, args);
  } catch (error) {
    if (!options.retry || error instanceof GatewayCallError || error instanceof McpError) throw error;
    connection = null;
    body = await callOnce(tool, operation, args);
  }
  const record = body as { data?: unknown };
  return (record.data !== undefined ? record.data : body) as T;
}
