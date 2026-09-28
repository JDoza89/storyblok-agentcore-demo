import { BedrockAgentCoreApp } from 'bedrock-agentcore/runtime';
import { Agent, NullConversationManager, type ToolList } from '@strands-agents/sdk';
import { AgentSkills } from '@strands-agents/sdk/vended-plugins/skills';
import type { InvokeArgs } from '@strands-agents/sdk';
import { z } from 'zod';

import { loadModel } from './model/load.js';
import { getAllGatewayMcpClients } from './mcp_client/client.js';
import { primeStoryblokPat, resolveStoryblokRegion, resolveStoryblokSpaceId } from './storyblok_kit/credentials.js';
import { LaunchInvariants } from './storyblok_kit/hooks/launch-invariants.js';
import { SpaceIdGuard } from './storyblok_kit/hooks/space-guard.js';
import { RunTracker, type Gap } from './storyblok_kit/run-tracker.js';
import { syncSkillsRoot } from './storyblok_kit/skills.js';
import { loadSpaceContext, renderSpaceContext, type SpaceContext } from './storyblok_kit/space-context.js';
import { postGapsAsComments, type PostResult } from './storyblok_kit/story-comments.js';
import { aiTranslateStory } from './storyblok_kit/tools/ai-translate.js';
import { makeFlagGapTool } from './storyblok_kit/tools/flag-gap.js';
import { makeReadSkillResourceTool } from './storyblok_kit/tools/skill-resources.js';
import { failures, repairPrompt, verifyStory, type Verification } from './storyblok_kit/verifier.js';

// The whole bucket, not a list of skills. Every skill directory at the root is
// discovered at runtime and the local cache is keyed on the bucket's current
// contents, so installing or editing a skill is an S3 upload and nothing else
// -- no code change, no redeploy, no restart.
const SKILLS_S3_ROOT = 's3://storyblok-agentcore-skills-485530831632';

// One follow-up turn when verification finds a problem. Enough to fix a missed
// SEO field or a stage the model forgot; a run that is still failing after a
// targeted repair needs a human, not a third attempt.
const MAX_REPAIR_TURNS = 1;

/**
 * Build this session's system prompt.
 *
 * Shorter than v1's in one way and longer in another. The AGENT_RESULT rules
 * are gone, because the harness writes that line from verified state. The live
 * space context is new: component schemas, the review stage, folders, and
 * brand guidelines, already fetched by code, so the model starts drafting
 * instead of spending its first dozen calls on discovery.
 */
function buildSystemPrompt(ctx: SpaceContext): string {
  return `
You are the Storyblok product-launch agent. You turn a product-launch brief into
a Storyblok landing page: assembling approved components, localizing into
target markets per brand guidelines, generating alt text and SEO metadata, and
leaving the result in the review stage for a human. You never publish.

Always invoke tools through the actual tool-calling mechanism available to you.
Never write a tool's arguments as plain JSON text in your response instead of
calling it.

Your Storyblok tools are exposed through the Gateway and are named
\`SBMCP___<tool>\` (for example \`SBMCP___execute_readonly\`,
\`SBMCP___execute_mutating\`). Skill text written for a direct MCP connection
may call these \`mcp__storyblok__<tool>\`; map it to the \`SBMCP___\` name.

**Before doing Storyblok work, activate \`productBrief-to-storyblokPage\` with
the \`skills\` tool and follow it.**

## What the harness does for you

- It has already read the space for this session. The content model, review
  stage, folders, and brand guidelines are below; don't re-discover them.
- It fills in \`space_id\` on every Storyblok call, so you can leave it out.
- It checks every write before it goes out and blocks the ones that break a
  launch rule (publishing, a non-review stage, numeric ids in reference
  fields, an update that would drop content). A blocked call comes back
  explaining what to change: fix that and retry.
- A block that isn't on its field's approved component list is left out of
  the write rather than blocking it. The readback names what was left out,
  and the harness flags it for the reviewer. Don't send it again.
- After every successful write it appends a readback of what actually landed
  in Storyblok. Trust the readback; you don't need to re-fetch to confirm it.
- When you finish, it verifies the story itself and may send you one
  follow-up listing anything left to fix.
- Record every gap for the human reviewer with \`flag_gap\`. The harness
  posts them as comments on the story after the run; don't post comments
  yourself.

## Space context

${renderSpaceContext(ctx)}

## How every run must end

Write your human-readable summary, then make the very last line:

NOTES: <one short sentence a human would want in a Slack message>

Do not write an AGENT_RESULT line. The harness writes it from what it verifies.
`;
}

function buildTools(skillsRoot: string, tracker: RunTracker): ToolList {
  return [
    aiTranslateStory,
    makeFlagGapTool(tracker),
    makeReadSkillResourceTool(skillsRoot),
    ...getAllGatewayMcpClients(),
  ];
}

interface Session {
  agent: Agent;
  ctx: SpaceContext;
  tracker: RunTracker;
}

const SESSION_CACHE_LIMIT = 128;

// Same LRU as v1, now holding the space context and run tracker alongside the
// agent, since the hooks and the verifier need the same instances the agent's
// plugins were built with.
const sessionCache = new Map<string, Session>();

async function getOrCreateSession(sessionId: string): Promise<Session> {
  const existing = sessionCache.get(sessionId);
  if (existing) {
    sessionCache.delete(sessionId);
    sessionCache.set(sessionId, existing);
    return existing;
  }
  if (sessionCache.size >= SESSION_CACHE_LIMIT) {
    const oldest = sessionCache.keys().next().value;
    if (oldest !== undefined) sessionCache.delete(oldest);
  }

  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) {
    throw new Error('Could not resolve the Storyblok space id -- refusing to start a session without it.');
  }
  const region = resolveStoryblokRegion();
  const [skillsRoot, ctx] = await Promise.all([
    syncSkillsRoot(SKILLS_S3_ROOT),
    loadSpaceContext(spaceId, region),
  ]);
  const tracker = new RunTracker();

  const agent = new Agent({
    model: loadModel(),
    systemPrompt: buildSystemPrompt(ctx),
    tools: buildTools(skillsRoot, tracker),
    conversationManager: new NullConversationManager(),
    plugins: [new SpaceIdGuard(), new LaunchInvariants(ctx, tracker), new AgentSkills({ skills: [skillsRoot] })],
  });
  const session = { agent, ctx, tracker };
  sessionCache.set(sessionId, session);
  return session;
}

/**
 * Pull the brief out of the request body. Every caller (the Slack app,
 * `agentcore invoke`) sends `{"prompt": "<text>"}`.
 */
export function extractPrompt(payload: Record<string, unknown>): string {
  const prompt = payload.prompt ?? '';
  if (typeof prompt !== 'string') throw new Error('prompt must be a string');
  return prompt;
}

/** Stream one agent turn, yielding text chunks and collecting the full text. */
async function* streamTurn(agent: Agent, prompt: InvokeArgs, collected: { text: string }) {
  collected.text = '';
  for await (const event of agent.stream(prompt)) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event?.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta?.type === 'textDelta'
    ) {
      collected.text += event.event.delta.text;
      yield { data: event.event.delta.text };
    }
  }
}

function lastNotesLine(text: string): string {
  const matches = [...text.matchAll(/^NOTES:\s*(.+)$/gm)];
  return matches.length > 0 ? matches[matches.length - 1]![1]!.trim() : '';
}

/**
 * The AGENT_RESULT line, built from the tracker and the verifier rather than
 * from the model's own claim. Same shape v1's callers already parse.
 */
/**
 * Every gap a reviewer should see on the story: the ones the agent flagged,
 * then any verification check still failing after the repair turn, then the
 * session's space warnings (branding unavailable, a missing review stage).
 */
function collectGaps(ctx: SpaceContext, tracker: RunTracker, verification: Verification | null): Gap[] {
  const harnessGaps: Gap[] = [
    ...(verification ? failures(verification) : []).map((check) => ({
      message: `Harness check failed after the run: ${check.name} (${check.detail}).`,
    })),
    ...ctx.warnings.map((warning) => ({ message: warning })),
  ];
  return [...tracker.gaps, ...harnessGaps];
}

function buildAgentResult(
  ctx: SpaceContext,
  tracker: RunTracker,
  verification: Verification | null,
  modelText: string,
  comments: PostResult | null,
) {
  const storyId = tracker.storyId;
  const remaining = verification ? failures(verification) : [];
  const critical = remaining.some((check) => check.critical);

  let status: 'created' | 'updated' | 'unchanged' | 'failed';
  if (storyId === null) status = 'unchanged';
  else if (critical) status = 'failed';
  else status = tracker.mode ?? 'updated';

  let notes = lastNotesLine(modelText);
  if (remaining.length > 0) {
    const flagged = `Harness flagged: ${remaining.map((check) => check.name).join(', ')}.`;
    notes = notes ? `${notes} ${flagged}` : flagged;
  }
  if (comments && comments.posted > 0) {
    notes = `${notes} ${comments.posted} gap(s) left as comments on the story.`.trim();
  }
  if (comments && comments.failed.length > 0) {
    notes = `${notes} ${comments.failed.length} gap(s) could not be posted as comments.`.trim();
  }

  return {
    status,
    storyId: storyId === null ? null : String(storyId),
    storyUrl:
      storyId === null ? null : `https://app.storyblok.com/#!/me/spaces/${ctx.spaceId}/stories/0/0/${storyId}`,
    locales: verification?.locales ?? {},
    notes,
  };
}

// Passthrough: extractPrompt validates the one field this agent reads.
const requestSchema = z.record(z.string(), z.unknown());

const app = new BedrockAgentCoreApp({
  invocationHandler: {
    requestSchema,
    async *process(payload, context) {
      context.log.info('Invoking Agent.....');

      // Cache the PAT once per container. Session setup needs it for the AI
      // branding rules, one of the two reads the MCP server doesn't cover.
      await primeStoryblokPat();

      const sessionId = context?.sessionId ?? 'default-session';
      const { agent, ctx, tracker } = await getOrCreateSession(sessionId);
      tracker.reset();

      const prompt = extractPrompt(payload);

      // Snapshot history before streaming so a failed turn can be rolled back;
      // see v1 for why a lingering user turn breaks the next invocation.
      const snapshot = agent.takeSnapshot({ include: ['messages'] });
      const collected = { text: '' };
      let verification: Verification | null = null;
      try {
        yield* streamTurn(agent, prompt, collected);

        for (let repair = 0; tracker.storyId !== null; repair++) {
          verification = await verifyStory(tracker.storyId, ctx, tracker);
          if (failures(verification).length === 0 || repair >= MAX_REPAIR_TURNS) break;
          context.log.info(`Verification failed: ${failures(verification).map((c) => c.name).join(', ')}`);
          yield { data: '\n\n' };
          yield* streamTurn(agent, repairPrompt(verification), collected);
        }
      } catch (error) {
        agent.loadSnapshot(snapshot);
        throw error;
      }

      // Post gaps only once the story is final, so a gap the agent resolved
      // later in the run, or during the repair turn, never becomes a stale comment.
      let comments: PostResult | null = null;
      if (tracker.storyId !== null) {
        const gaps = collectGaps(ctx, tracker, verification);
        if (gaps.length > 0) comments = await postGapsAsComments(tracker.storyId, gaps);
      }

      const result = buildAgentResult(ctx, tracker, verification, collected.text, comments);
      yield { data: `\n\nAGENT_RESULT: ${JSON.stringify(result)}` };
    },
  },
});

app.run({ port: parseInt(process.env.PORT ?? '8080') });
