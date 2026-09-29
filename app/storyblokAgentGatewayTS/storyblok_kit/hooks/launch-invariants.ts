import {
  InterventionActions,
  InterventionHandler,
  TextBlock,
  ToolResultBlock,
  type AfterToolCallEvent,
  type BeforeToolCallEvent,
  type OnError,
} from '@strands-agents/sdk';

import type { RunTracker } from '../run-tracker.js';
import { CONTENT_TYPE, type SpaceContext } from '../space-context.js';
import {
  blockUids,
  bodyLength,
  droppedKeys,
  invalidReferences,
  renderReadback,
  stripDisallowedComponents,
  type RemovedBlock,
} from '../story-checks.js';
import { getStory, type StoryblokStory } from '../storyblok-reads.js';

const { deny, proceed, transform } = InterventionActions;

/**
 * The launch rules, enforced on every Storyblok tool call as Strands
 * intervention handlers.
 *
 * Cedar on the Gateway decides which SBMCP operations may run, but it can't see
 * their nested `parameters`, which is where most launch mistakes live:
 * `publish: true` on an allowed `updateStory`, a stage change to a publishing
 * stage, a numeric id in a reference field, an update that wipes a page's body.
 * These handlers see the full call.
 *
 * Interventions run in registration order on each tool call. A `transform`
 * edits the call and later handlers see the edit; a `deny` cancels it, shows
 * the model the reason, and skips the rest. Every before-call handler here is
 * `onError: 'deny'`, so a check that throws blocks the call instead of letting
 * it through. The pipeline, in order:
 *
 *   1. FillSpaceId            transform  add this space's id where the call omits it
 *   2. StripUnapprovedBlocks  transform  drop blocks their field's whitelist doesn't allow
 *   3. LaunchRules            deny       every rule that refuses a call outright
 *   4. WriteReadback          after      record the write, report stripped blocks, append a readback
 *
 * (SpaceIdGuard, registered before these, denies a call aimed at another space.)
 */

type Params = Record<string, unknown>;

const STORYBLOK_EXECUTE = /(?:^|_)execute_(mutating|readonly|destructive)$/;
const BLOCKED_PREFIX = 'Blocked by the harness: ';

function isObject(value: unknown): value is Params {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** First value under `key` anywhere in the tree -- the MCP server may nest the request body. */
function findKey(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findKey(item, key);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isObject(value)) return undefined;
  if (key in value) return value[key];
  for (const nested of Object.values(value)) {
    const found = findKey(nested, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isTruthyFlag(value: unknown): boolean {
  return value === true || value === 1 || value === '1' || value === 'true';
}

function asId(value: unknown): number | null {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  return null;
}

/** Text of a tool result, with JSON blocks serialized, for pulling ids out of it. */
function resultText(result: ToolResultBlock): string {
  return result.content
    .map((block) => {
      if ('text' in block && typeof block.text === 'string') return block.text;
      if ('json' in block) return JSON.stringify(block.json);
      return '';
    })
    .join('\n');
}

function createdStoryId(result: ToolResultBlock): number | null {
  const text = resultText(result);
  try {
    const parsed = JSON.parse(text) as unknown;
    return asId(findKey(findKey(parsed, 'story'), 'id'));
  } catch {
    const match = /"story"\s*:\s*\{[^{}]*?"id"\s*:\s*(\d+)/.exec(text);
    return match ? Number(match[1]) : null;
  }
}

/**
 * The story id an updateStory targets. Looked up in known places only: a deep
 * search would fall through into story.content and find an asset's `id`.
 */
function updateTargetId(params: Params): number | null {
  const story = findKey(params, 'story');
  return asId(params.id) ?? asId(params.story_id) ?? (isObject(story) ? asId(story.id) : null);
}

function looksLikeFailure(result: ToolResultBlock): boolean {
  if (result.status === 'error') return true;
  return /"(error|errors)"\s*:|HTTP [45]\d\d|status(Code)?"?\s*:\s*[45]\d\d/i.test(resultText(result));
}

/** A Storyblok execute call's operation and parameters, or null for any other tool. */
function storyblokCall(event: BeforeToolCallEvent | AfterToolCallEvent): { operation: string; params: Params } | null {
  const input = event.toolUse.input;
  if (!STORYBLOK_EXECUTE.test(event.toolUse.name ?? '') || !isObject(input)) return null;
  const operation = typeof input.operation === 'string' ? input.operation : '';
  return { operation, params: isObject(input.parameters) ? input.parameters : {} };
}

/** A createStory/updateStory call's story and content, or null for folders and content-less writes. */
function storyWrite(params: Params): { story: Params; content: Params } | null {
  const story = findKey(params, 'story');
  if (!isObject(story) || isTruthyFlag(story.is_folder) || !isObject(story.content)) return null;
  return { story, content: story.content };
}

/**
 * State the pipeline shares across one tool call: the story an update targets,
 * read once for both the strip and the destructive-update check, and the blocks
 * stripped from a write, held until its result arrives.
 */
class WriteState {
  private readonly current = new Map<string, Promise<StoryblokStory>>();
  readonly removed = new Map<string, RemovedBlock[]>();

  currentStory(toolUseId: string, storyId: number): Promise<StoryblokStory> {
    let story = this.current.get(toolUseId);
    if (!story) {
      story = getStory(storyId);
      this.current.set(toolUseId, story);
    }
    return story;
  }

  forget(toolUseId: string): void {
    this.current.delete(toolUseId);
    this.removed.delete(toolUseId);
  }
}

/** Every call gets this deployment's space id; SpaceIdGuard already denied a different one. */
class FillSpaceId extends InterventionHandler {
  readonly name = 'storyblok-fill-space-id';
  override readonly onError: OnError = 'deny';

  constructor(private readonly ctx: SpaceContext) {
    super();
  }

  override beforeToolCall(event: BeforeToolCallEvent) {
    const call = storyblokCall(event);
    if (!call || call.params.space_id !== undefined) return proceed();
    const input = event.toolUse.input as Params;
    return transform(() => {
      input.parameters = { ...call.params, space_id: this.ctx.spaceId };
    }, { reason: 'space_id filled in' });
  }
}

/**
 * Unapproved blocks are dropped, not refused: the write goes ahead without
 * them, and WriteReadback tells the model and flags each one for the reviewer.
 * On an update, blocks already on the story are never removed.
 */
class StripUnapprovedBlocks extends InterventionHandler {
  readonly name = 'storyblok-strip-unapproved-blocks';
  override readonly onError: OnError = 'deny';

  constructor(
    private readonly ctx: SpaceContext,
    private readonly state: WriteState,
  ) {
    super();
  }

  override async beforeToolCall(event: BeforeToolCallEvent) {
    const call = storyblokCall(event);
    if (!call || (call.operation !== 'createStory' && call.operation !== 'updateStory')) return proceed();
    const write = storyWrite(call.params);
    if (!write) return proceed();

    let keep = new Set<string>();
    if (call.operation === 'updateStory') {
      const storyId = updateTargetId(call.params);
      // LaunchRules denies an update it can't check; nothing to strip against.
      if (storyId === null) return proceed();
      try {
        keep = blockUids((await this.state.currentStory(event.toolUse.toolUseId, storyId)).content);
      } catch {
        return proceed();
      }
    }

    // Strip a copy first, so a call with nothing to strip goes through untouched.
    const cleaned = structuredClone(write.content);
    const removed = stripDisallowedComponents(cleaned, this.ctx, keep);
    if (removed.length === 0) return proceed();
    this.state.removed.set(event.toolUse.toolUseId, removed);
    return transform(() => {
      write.story.content = cleaned;
    }, { reason: `stripped ${removed.length} unapproved block(s)` });
  }
}

/** Every rule that refuses a call outright, with a reason the model can act on. */
class LaunchRules extends InterventionHandler {
  readonly name = 'storyblok-launch-rules';
  override readonly onError: OnError = 'deny';

  constructor(
    private readonly ctx: SpaceContext,
    private readonly tracker: RunTracker,
    private readonly state: WriteState,
  ) {
    super();
  }

  override async beforeToolCall(event: BeforeToolCallEvent) {
    const reason = await this.check(event);
    if (!reason) return proceed();
    this.state.forget(event.toolUse.toolUseId);
    console.warn(`Blocked ${event.toolUse.name}: ${reason}`);
    return deny(`${BLOCKED_PREFIX}${reason}`);
  }

  private async check(event: BeforeToolCallEvent): Promise<string | null> {
    const toolName = event.toolUse.name ?? '';
    const input = event.toolUse.input;

    if (toolName === 'ai_translate_story' && isObject(input) && typeof input.lang === 'string') {
      this.tracker.locales.add(input.lang);
      return null;
    }
    // Backstop for the tool filter on the model's MCP client: SBMAPI's tools are
    // the harness's, and the raw translate trigger skips ai_translate_story's
    // per-story queue and wait.
    if (toolName.startsWith('SBMAPI___')) {
      return `'${toolName}' is called by the harness, not the agent. To translate a story, use ai_translate_story.`;
    }

    const call = storyblokCall(event);
    if (!call) return null;
    const { operation, params } = call;

    // Publish *operations* never get this far: none is on Cedar's allowlist. The
    // flag on an allowed operation is what needs checking here.
    if (isTruthyFlag(findKey(params, 'publish'))) {
      return `'${operation}' was called with publish set. Send it again without the publish flag; stories are never published by this agent.`;
    }

    // The harness posts gaps as story comments itself, once the run is final.
    // A direct post from the model would duplicate them, or go stale if the
    // gap gets resolved later in the run.
    if (/^create(Discussion|Comment)/.test(operation)) {
      return `'${operation}' is not for the agent to call. Record the gap with the flag_gap tool instead; the harness posts it as a comment on the story when the run ends.`;
    }

    if (operation === 'createWorkflowStageChange') return this.checkStageChange(params);
    if (operation === 'createStory' || operation === 'updateStory') {
      return this.checkStoryWrite(operation, params, event.toolUse.toolUseId);
    }
    return null;
  }

  private checkStageChange(params: Params): string | null {
    const review = this.ctx.reviewStage;
    if (!review) return 'the space has no usable non-publishing review stage, so no stage change is allowed.';
    const target = asId(findKey(params, 'workflow_stage_id'));
    if (target !== review.id) {
      return (
        `workflow_stage_id ${String(target)} is not the review stage. The only stage this agent may ` +
        `move a story into is '${review.name}' (id ${review.id}).`
      );
    }
    return null;
  }

  private async checkStoryWrite(operation: string, params: Params, toolUseId: string): Promise<string | null> {
    const write = storyWrite(params);
    if (!write) return null;
    const { content } = write;

    if (operation === 'createStory' && content.component !== CONTENT_TYPE) {
      return `new stories must have content.component '${CONTENT_TYPE}', not '${String(content.component)}'.`;
    }

    const badRefs = invalidReferences(content, this.ctx);
    if (badRefs.length > 0) {
      return (
        `these story-reference values are not uuids: ${badRefs.join('; ')}. Reference fields take the ` +
        "story's 36-character uuid, never its numeric id. Look up each story's uuid and send the write again."
      );
    }

    if (operation !== 'updateStory') return null;

    // updateStory replaces story.content in full, so compare against what is there now.
    const storyId = updateTargetId(params);
    if (storyId === null) return 'updateStory needs the numeric story id in parameters.id.';
    let current;
    try {
      current = await this.state.currentStory(toolUseId, storyId);
    } catch (error) {
      return `the harness could not read story ${storyId} to check this update (${String(error)}). Try the update again.`;
    }

    const before = bodyLength(current.content) ?? 0;
    const after = bodyLength(content);
    const dropped = droppedKeys(current.content, content);
    if (content.component !== current.content.component) {
      return `content.component changed from '${String(current.content.component)}' to '${String(content.component)}'.`;
    }
    if (after === null || after < before || dropped.length > 0) {
      return (
        `this update would remove existing content (body ${before} -> ${after ?? 'missing'} block(s)` +
        `${dropped.length > 0 ? `; fields dropped: ${dropped.join(', ')}` : ''}). updateStory replaces the whole ` +
        'content object: call getStoryById now, change only what you intend to on that fresh copy, and send ' +
        'the complete object. If removing blocks is genuinely what the brief asks for, leave them and say so ' +
        'in your summary; a human removes blocks in the Visual Editor.'
      );
    }
    return null;
  }
}

/**
 * After a successful write: record it in the run tracker, flag any stripped
 * blocks for the reviewer, and append a one-line readback of what landed, so
 * the model doesn't re-fetch the story to confirm. A failed readback never
 * blocks anything (`onError: 'proceed'`); the write already happened.
 */
class WriteReadback extends InterventionHandler {
  readonly name = 'storyblok-write-readback';
  override readonly onError: OnError = 'proceed';

  constructor(
    private readonly ctx: SpaceContext,
    private readonly tracker: RunTracker,
    private readonly state: WriteState,
  ) {
    super();
  }

  override async afterToolCall(event: AfterToolCallEvent) {
    const call = storyblokCall(event);
    const toolUseId = event.toolUse.toolUseId;
    if (!call) {
      this.state.forget(toolUseId);
      return proceed();
    }
    const failed = looksLikeFailure(event.result);
    const removedNote = this.reportRemoved(toolUseId, !failed);
    this.state.forget(toolUseId);
    if (failed) return proceed();

    const readback = await this.readbackFor(call.operation, call.params, event.result);
    const note = [removedNote, readback].filter(Boolean).join('\n');
    if (!note) return proceed();
    return transform(() => {
      event.result = new ToolResultBlock({
        toolUseId: event.result.toolUseId,
        status: event.result.status,
        content: [...event.result.content, new TextBlock(note)],
      });
    }, { reason: 'readback appended' });
  }

  private reportRemoved(toolUseId: string, succeeded: boolean): string | null {
    const removed = this.state.removed.get(toolUseId);
    if (!removed || !succeeded) return null;
    for (const block of removed) {
      this.tracker.gaps.push({
        message:
          `The harness left a '${block.component}' block out of ${block.parentComponent}.${block.field} because it ` +
          `isn't on that field's approved component list (${block.allowed.join(', ') || 'none listed'}). ` +
          'If this content belongs on the page, add it with an approved component.',
        component: block.parentComponent,
        ...(block.parentUid ? { blockUid: block.parentUid } : {}),
        fieldname: block.field,
      });
    }
    const list = removed.map((block) => `'${block.component}' at ${block.path}`).join('; ');
    return (
      `[harness] Left out of this write because they aren't on their field's approved component list: ${list}. ` +
      'Each one is flagged for the reviewer. Build that content from approved components if one fits, and ' +
      "don't send these blocks again."
    );
  }

  private async readbackFor(operation: string, params: Params, result: ToolResultBlock): Promise<string | null> {
    let storyId: number | null = null;
    if (operation === 'createStory') {
      const story = findKey(params, 'story');
      if (isObject(story) && isTruthyFlag(story.is_folder)) return null;
      storyId = createdStoryId(result);
      if (storyId !== null) this.tracker.recordCreate(storyId);
    } else if (operation === 'updateStory') {
      storyId = updateTargetId(params);
      if (storyId !== null) this.tracker.recordUpdate(storyId);
    } else if (operation === 'createWorkflowStageChange') {
      storyId = asId(findKey(params, 'story_id'));
      if (storyId !== null) this.tracker.stagedStories.add(storyId);
    } else {
      return null;
    }
    if (storyId === null) return null;

    try {
      const story = await getStory(storyId);
      return renderReadback(story, this.ctx, [...this.tracker.locales], this.tracker.stagedStories.has(storyId));
    } catch (error) {
      return `[harness readback unavailable for story ${storyId}: ${String(error)}]`;
    }
  }
}

/** The launch-rule pipeline, in the order the handlers must run. */
export function launchInterventions(ctx: SpaceContext, tracker: RunTracker): InterventionHandler[] {
  const state = new WriteState();
  return [
    new FillSpaceId(ctx),
    new StripUnapprovedBlocks(ctx, state),
    new LaunchRules(ctx, tracker, state),
    new WriteReadback(ctx, tracker, state),
  ];
}
