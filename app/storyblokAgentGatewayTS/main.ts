import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, NullConversationManager, type ToolList } from '@strands-agents/sdk';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import type { InvokeArgs, MessageData } from '@strands-agents/sdk';
import { z } from 'zod';

import { loadModel } from './model/load.js';
import { getAllGatewayMcpClients } from './mcp_client/client.js';
import { resolveStoryblokRegion, resolveStoryblokSpaceId } from './storyblok_kit/credentials.js';
import { SpaceIdGuard } from './storyblok_kit/hooks/space-guard.js';
import { syncSkillsRoot } from './storyblok_kit/skills.js';
import { fetchAiBrandingGuidelines } from './storyblok_kit/tools/ai-branding.js';
import { aiTranslateStory } from './storyblok_kit/tools/ai-translate.js';
import { makeReadSkillResourceTool } from './storyblok_kit/tools/skill-resources.js';

// The whole bucket, not a list of skills. Every skill directory under this
// prefix is discovered at runtime, so installing a skill is an S3 upload and a
// restart -- no code change, no redeploy.
const SKILLS_S3_ROOT = 's3://storyblok-agentcore-skills-485530831632';

/**
 * Build this session's system prompt.
 *
 * Skill instructions are no longer concatenated in here. The `AgentSkills`
 * plugin injects each skill's name and description before every invocation and
 * the agent pulls a skill's full text on demand through the `skills` tool, so
 * the base prompt stays small and a skill's `references/` files stay reachable
 * instead of being flattened away.
 */
function buildSystemPrompt(): string {
  return `
You are the Storyblok product-launch agent (Gateway-connected variant --
reaches Storyblok's MCP server through an AgentCore Gateway target rather
than connecting to it directly). You turn a product-launch brief into a
Storyblok landing page: assembling approved components, localizing into
target markets per brand guidelines, generating alt text and SEO metadata,
and moving the result into the pre-publish review workflow stage. You never
attempt to publish directly — you do not have publish rights, and should not
try to work around that.

Always invoke tools through the actual tool-calling mechanism available to you.
Never write a tool's arguments as plain JSON text in your response instead of
calling it — if you notice yourself about to do that, stop and make the real
tool call. A run that ends by printing JSON instead of calling a tool is a
failed run, not a completed one.

Your Storyblok tools are exposed through the Gateway and are named
\`SBMCP___<tool>\` (for example \`SBMCP___search\`, \`SBMCP___describe\`,
\`SBMCP___execute_readonly\`, \`SBMCP___execute_mutating\`). Skill text written
for a direct MCP connection may call these \`mcp__storyblok__<tool>\` — the
suffix after the final underscores is the same tool, so map it to the
\`SBMCP___\` name you actually have.

**Before doing Storyblok work, activate the relevant skill with the \`skills\`
tool and follow it.** Start with \`productBrief-to-storyblokPage\` for a
product-launch brief; it will tell you which others to load.
`;
}

/**
 * Assemble this session's tools: local tools plus MCP clients.
 *
 * Called per-session (from getOrCreateAgent), not at module import time --
 * constructing the Gateway McpClient at module load time (before any request
 * context exists) left its discovered tools disconnected from what the model
 * actually saw. Building it per-session, inside real request handling, avoids
 * that.
 *
 * Local tools and the Gateway McpClient coexist in one list with no issues. An
 * earlier debugging pass on the Python agent concluded otherwise ("confirmed
 * reproducible 3/3") and moved these out to a Lambda-backed "aiTools" Gateway
 * target; that conclusion didn't hold up. The real causes were two unrelated,
 * since-fixed bugs: (1) a client-side `prefix` double-stacking with the
 * Gateway's own `{target}___{tool}` naming into names the model avoided
 * calling, and (2) the Gateway's execution role missing
 * `bedrock-agentcore:GetResourceApiKey` on the correct workload-identity ARN
 * (scoped to the target name "SBMCP" rather than the gateway's own id), which
 * failed every Storyblok MCP tool call.
 */
function buildTools(skillsRoot: string): ToolList {
  return [
    fetchAiBrandingGuidelines,
    aiTranslateStory,
    makeReadSkillResourceTool(skillsRoot),
    ...getAllGatewayMcpClients(),
  ];
}

const AGENT_CACHE_LIMIT = 128;

// Reuses one Agent per sessionId so each session keeps its own in-process
// conversation history (best-effort; resets on cold start). A Map preserves
// insertion order, so it doubles as an LRU bounded to 128 sessions — a single
// process serving many sessions cannot leak history between them or grow
// without limit. For durable history, attach a session manager.
const agentCache = new Map<string, Agent>();

async function getOrCreateAgent(sessionId: string): Promise<Agent> {
  const existing = agentCache.get(sessionId);
  if (existing) {
    agentCache.delete(sessionId);
    agentCache.set(sessionId, existing);
    return existing;
  }
  if (agentCache.size >= AGENT_CACHE_LIMIT) {
    const oldest = agentCache.keys().next().value;
    if (oldest !== undefined) agentCache.delete(oldest);
  }

  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) {
    throw new Error('Could not resolve the Storyblok space id -- refusing to start a session without it.');
  }
  const skillsRoot = await syncSkillsRoot(SKILLS_S3_ROOT, {
    placeholders: { SPACE_ID: String(spaceId), REGION: resolveStoryblokRegion() },
  });

  const agent = new Agent({
    model: loadModel(),
    systemPrompt: buildSystemPrompt(),
    tools: buildTools(skillsRoot),
    conversationManager: new NullConversationManager(),
    plugins: [new SpaceIdGuard(), new AgentSkills({ skills: [skillsRoot] })],
  });
  agentCache.set(sessionId, agent);
  return agent;
}

/** Strip toolUse blocks from the tail until the last message has none. */
export function stripTrailingToolUse(messages: unknown): MessageData[] {
  if (!Array.isArray(messages)) throw new Error('messages must be a list');

  const result = [...messages] as MessageData[];
  while (result.length > 0) {
    const last = result[result.length - 1];
    if (last === null || typeof last !== 'object' || Array.isArray(last)) {
      throw new Error('each message must be an object');
    }
    const originalContent = (last as { content?: unknown }).content ?? [];
    if (
      !Array.isArray(originalContent) ||
      !originalContent.every((block) => block !== null && typeof block === 'object' && !Array.isArray(block))
    ) {
      throw new Error('each message content value must be a list of content blocks');
    }

    const content = originalContent.filter((block) => !('toolUse' in (block as object)));
    if (content.length === originalContent.length) break;
    if (content.length > 0) {
      result[result.length - 1] = { ...last, content } as MessageData;
      break;
    }
    result.pop();
  }

  return result;
}

/** Accept validated harness messages, tool results, or a plain prompt string. */
export function extractPrompt(payload: Record<string, unknown>): InvokeArgs {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be a JSON object');
  }

  if ('messages' in payload) return stripTrailingToolUse(payload.messages);

  if ('tool_results' in payload) {
    const toolResults = payload.tool_results;
    if (
      !Array.isArray(toolResults) ||
      !toolResults.every(
        (tr) =>
          tr !== null &&
          typeof tr === 'object' &&
          typeof (tr as { toolUseId?: unknown }).toolUseId === 'string',
      )
    ) {
      throw new Error('tool_results must contain objects with a toolUseId string');
    }
    return [
      {
        role: 'user',
        content: (toolResults as Record<string, unknown>[]).map((tr) => ({
          toolResult: {
            toolUseId: tr.toolUseId as string,
            status: (tr.status as string | undefined) ?? 'success',
            content: (tr.content as unknown[] | undefined) ?? [],
          },
        })),
      },
    ] as MessageData[];
  }

  const prompt = payload.prompt ?? '';
  if (typeof prompt !== 'string') throw new Error('prompt must be a string');
  return prompt;
}

// Passthrough rather than a fixed shape: extractPrompt accepts three payload
// forms (messages / tool_results / prompt) and validates whichever arrived.
const requestSchema = z.record(z.string(), z.unknown());

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      context.log.info('Invoking Agent.....');

      const sessionId = context?.sessionId ?? 'default-session';
      const agent = await getOrCreateAgent(sessionId);
      const prompt = extractPrompt(payload);

      // Snapshot history before streaming so a failed turn can be rolled back.
      // Agent.stream() appends the user message before invoking the model; on a
      // mid-stream error that user turn would otherwise linger in the cached
      // agent, and the next turn for this session would send consecutive user
      // messages (rejected by providers that require strict role alternation,
      // e.g. Anthropic). Restoring on error keeps the session reusable.
      const snapshot = agent.takeSnapshot({ include: ['messages'] });
      try {
        for await (const event of agent.stream(prompt)) {
          if (
            event.type === 'modelStreamUpdateEvent' &&
            event.event?.type === 'modelContentBlockDeltaEvent' &&
            event.event.delta?.type === 'textDelta'
          ) {
            yield { data: event.event.delta.text };
          }
        }
      } catch (error) {
        agent.loadSnapshot(snapshot);
        throw error;
      }
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
