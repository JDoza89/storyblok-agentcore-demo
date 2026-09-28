import {
  AfterToolCallEvent,
  BeforeToolCallEvent,
  TextBlock,
  ToolResultBlock,
  type LocalAgent,
  type Plugin,
} from '@strands-agents/sdk';

import { getStory } from '../storyblok-reads.js';
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

/**
 * The launch rules that v1 kept as prose in productBrief-to-storyblokPage,
 * enforced in code on every Storyblok tool call instead.
 *
 * v1 already proved the pattern twice: SpaceIdGuard and the per-story translate
 * queue are the two rules that moved out of the skill into code, and neither
 * failed again afterwards. Everything below is a rule that did fail while it
 * lived in prose: a story moved to a publishing stage, an update that wiped a
 * page's body, numeric ids written into reference fields.
 *
 * Cedar on the Gateway is still the outer boundary, and it only sees the
 * operation name. These hooks see the parameters, which is where most of these
 * mistakes actually live -- `publish: true` on an otherwise-permitted
 * `updateStory` passes policy.
 */

type Params = Record<string, unknown>;

const STORYBLOK_EXECUTE = /(?:^|_)execute_(mutating|readonly|destructive)$/;

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

export class LaunchInvariants implements Plugin {
  readonly name = 'storyblok-launch-invariants';

  constructor(
    private readonly ctx: SpaceContext,
    private readonly tracker: RunTracker,
  ) {}

  /** Blocks stripped from a write, keyed by tool-use id until the write's result arrives. */
  private readonly removedByToolUse = new Map<string, RemovedBlock[]>();

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, async (event) => {
      const cancel = await this.checkBefore(event.toolUse.name ?? '', event.toolUse.input, event.toolUse.toolUseId);
      if (cancel) {
        console.warn(`Blocked ${event.toolUse.name}: ${cancel}`);
        event.cancel = `Blocked by the harness: ${cancel}`;
      }
    });

    agent.addHook(AfterToolCallEvent, async (event) => {
      const readback = await this.readbackAfter(
        event.toolUse.name ?? '',
        event.toolUse.input,
        event.result,
        event.toolUse.toolUseId,
      );
      if (readback) {
        event.result = new ToolResultBlock({
          toolUseId: event.result.toolUseId,
          status: event.result.status,
          content: [...event.result.content, new TextBlock(readback)],
        });
      }
    });
  }

  /** Returns a reason to cancel the call, or null to let it through. */
  private async checkBefore(toolName: string, input: unknown, toolUseId: string): Promise<string | null> {
    if (toolName === 'ai_translate_story' && isObject(input) && typeof input.lang === 'string') {
      this.tracker.locales.add(input.lang);
      return null;
    }
    if (!STORYBLOK_EXECUTE.test(toolName) || !isObject(input)) return null;

    const operation = typeof input.operation === 'string' ? input.operation : '';
    if (!isObject(input.parameters)) input.parameters = {};
    const params = input.parameters as Params;

    // The one fact every call needs and the model never has to supply.
    // SpaceIdGuard still rejects a *different* space id if one is passed.
    if (params.space_id === undefined) params.space_id = this.ctx.spaceId;

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
    if (operation === 'createStory' || operation === 'updateStory') return this.checkStoryWrite(operation, params, toolUseId);
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
    const story = findKey(params, 'story');
    if (!isObject(story) || isTruthyFlag(story.is_folder)) return null;
    const content = story.content;
    if (!isObject(content)) return null;

    if (operation === 'createStory' && content.component !== CONTENT_TYPE) {
      return `new stories must have content.component '${CONTENT_TYPE}', not '${String(content.component)}'.`;
    }

    // updateStory replaces story.content in full, so read what is there now:
    // the destructive-update check compares against it, and blocks already on
    // the story are never stripped below.
    let current;
    if (operation === 'updateStory') {
      const storyId = updateTargetId(params);
      if (storyId === null) return 'updateStory needs the numeric story id in parameters.id.';
      try {
        current = await getStory(storyId);
      } catch (error) {
        return `the harness could not read story ${storyId} to check this update (${String(error)}). Try the update again.`;
      }
    }

    // Unapproved blocks are dropped, not refused: the write goes ahead without
    // them, and the after-hook tells the model and flags each one for the reviewer.
    const removed = stripDisallowedComponents(content, this.ctx, current ? blockUids(current.content) : new Set());
    if (removed.length > 0) this.removedByToolUse.set(toolUseId, removed);

    const badRefs = invalidReferences(content, this.ctx);
    if (badRefs.length > 0) {
      this.removedByToolUse.delete(toolUseId);
      return (
        `these story-reference values are not uuids: ${badRefs.join('; ')}. Reference fields take the ` +
        "story's 36-character uuid, never its numeric id. Look up each story's uuid and send the write again."
      );
    }

    if (!current) return null;
    const before = bodyLength(current.content) ?? 0;
    const after = bodyLength(content);
    const dropped = droppedKeys(current.content, content);
    let refusal: string | null = null;
    if (content.component !== current.content.component) {
      refusal = `content.component changed from '${String(current.content.component)}' to '${String(content.component)}'.`;
    } else if (after === null || after < before || dropped.length > 0) {
      refusal =
        `this update would remove existing content (body ${before} -> ${after ?? 'missing'} block(s)` +
        `${dropped.length > 0 ? `; fields dropped: ${dropped.join(', ')}` : ''}). updateStory replaces the whole ` +
        'content object: call getStoryById now, change only what you intend to on that fresh copy, and send ' +
        'the complete object. If removing blocks is genuinely what the brief asks for, leave them and say so ' +
        'in your summary; a human removes blocks in the Visual Editor.';
    }
    if (refusal) this.removedByToolUse.delete(toolUseId);
    return refusal;
  }

  /**
   * Once a write with stripped blocks has succeeded, flag each removed block for
   * the reviewer (pinned to the field it would have gone in) and return a line
   * telling the model what didn't land.
   */
  private reportRemoved(toolUseId: string, succeeded: boolean): string | null {
    const removed = this.removedByToolUse.get(toolUseId);
    this.removedByToolUse.delete(toolUseId);
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

  /** After a successful write, record it and return a compact readback to append. */
  private async readbackAfter(
    toolName: string,
    input: unknown,
    result: ToolResultBlock,
    toolUseId: string,
  ): Promise<string | null> {
    if (!STORYBLOK_EXECUTE.test(toolName) || !isObject(input)) return null;
    const failed = looksLikeFailure(result);
    const removedNote = this.reportRemoved(toolUseId, !failed);
    if (failed) return null;
    const readback = await this.readbackFor(input, result);
    return [removedNote, readback].filter(Boolean).join('\n') || null;
  }

  private async readbackFor(input: Params, result: ToolResultBlock): Promise<string | null> {
    const operation = input.operation;
    const params = isObject(input.parameters) ? input.parameters : {};

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
