import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpClient } from '@strands-agents/sdk';

import { createSigV4Fetch } from '../storyblok_kit/sigv4.js';

const AWS_SERVICE = 'bedrock-agentcore';

/** Returns an MCP Client connected to the reInventDemoGateway gateway. */
export function getReinventdemogatewayMcpClient(): McpClient | null {
  const url = process.env.AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL;
  if (!url) {
    console.warn(
      'AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL not set — reInventDemoGateway gateway tools unavailable',
    );
    return null;
  }

  // The transport reuses this fetch for the POST, the SSE GET, and the session
  // DELETE, so signing has to happen per request rather than once up front.
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    fetch: createSigV4Fetch({ service: AWS_SERVICE }),
  });
  // No `prefix` here on purpose: the Gateway already namespaces its tools as
  // `{target}___{tool}` (e.g. SBMCP___search). Adding a client-side prefix on
  // top produced names unwieldy enough that the model avoided calling them.
  // The SBMAPI target's tools (AI branding, AI translate) are the harness's to
  // call, not the model's: ai_translate_story wraps the translate trigger with
  // a per-story queue and a wait, and calling the raw tool would skip both.
  return new McpClient({ transport, toolFilters: { rejected: [/^SBMAPI___/] } });
}

/** Returns MCP clients for all configured gateways. */
export function getAllGatewayMcpClients(): McpClient[] {
  const client = getReinventdemogatewayMcpClient();
  return client ? [client] : [];
}
