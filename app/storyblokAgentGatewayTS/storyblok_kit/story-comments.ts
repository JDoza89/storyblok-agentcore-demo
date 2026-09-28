import { callGateway, MUTATING_TOOL } from './gateway.js';
import type { Gap } from './run-tracker.js';
import { getStory } from './storyblok-reads.js';

/**
 * Post the run's gaps to the story as discussions, so a reviewer finds them in
 * the Visual Editor next to the content they're about, not only in a Slack
 * summary.
 *
 * The one write the harness makes itself, and it goes through the Gateway like
 * the model's writes, so Cedar authorizes it (createDiscussionForStory is on the
 * allowlist). The model can't call createDiscussionForStory directly (the
 * launch-invariant hook blocks it), so each gap is posted exactly once, here.
 */

export const DISCUSSION_TITLE = 'Launch agent';

export interface PostResult {
  posted: number;
  failed: string[];
}

interface Anchor {
  blockUid: string;
  component?: string;
  fieldname?: string;
}

type Content = Record<string, unknown>;

function isObject(value: unknown): value is Content {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Every `_uid` in the content tree, mapped to its block's component name. */
function blockIndex(content: unknown, index = new Map<string, string | undefined>()): Map<string, string | undefined> {
  if (Array.isArray(content)) {
    for (const item of content) blockIndex(item, index);
  } else if (isObject(content)) {
    if (typeof content._uid === 'string') {
      index.set(content._uid, typeof content.component === 'string' ? content.component : undefined);
    }
    for (const nested of Object.values(content)) blockIndex(nested, index);
  }
  return index;
}

/**
 * Where a gap's discussion attaches. Storyblok requires a block_uid on every
 * discussion, so a gap that isn't about one block, or names a block the story
 * doesn't have (a wrong `_uid`, or one removed later in the run), attaches to
 * the story's root block instead. The message then names the block and field
 * it was about, so nothing the agent said is lost.
 */
function anchorFor(gap: Gap, blocks: Map<string, string | undefined>, root: Anchor): { anchor: Anchor; message: string } {
  if (gap.blockUid && blocks.has(gap.blockUid)) {
    const component = gap.component ?? blocks.get(gap.blockUid);
    return {
      anchor: {
        blockUid: gap.blockUid,
        ...(component ? { component } : {}),
        ...(gap.fieldname ? { fieldname: gap.fieldname } : {}),
      },
      message: gap.message,
    };
  }
  if (!gap.blockUid && gap.fieldname) {
    // A field on the content type itself, such as an SEO field.
    return { anchor: { ...root, fieldname: gap.fieldname }, message: gap.message };
  }
  const about = [gap.component, gap.fieldname].filter(Boolean).join('.');
  return { anchor: root, message: about ? `(${about}) ${gap.message}` : gap.message };
}

async function postOne(storyId: number, anchor: Anchor, message: string): Promise<void> {
  await callGateway({
    tool: MUTATING_TOOL,
    operation: 'createDiscussionForStory',
    parameters: {
      story_id: storyId,
      discussion: {
        title: DISCUSSION_TITLE,
        block_uid: anchor.blockUid,
        ...(anchor.component ? { component: anchor.component } : {}),
        ...(anchor.fieldname ? { fieldname: anchor.fieldname } : {}),
        comment: { message },
      },
    },
  });
}

/**
 * Post each gap once, in order. A failure never fails the run: the gaps are
 * still in the model's summary, each failure is logged with its message so it
 * can be recovered, and the caller reports how many didn't post.
 */
export async function postGapsAsComments(storyId: number, gaps: Gap[]): Promise<PostResult> {
  const result: PostResult = { posted: 0, failed: [] };

  let content: Content;
  try {
    content = (await getStory(storyId)).content;
  } catch (error) {
    console.warn(`Could not read story ${storyId} to post gaps: ${String(error)}`);
    for (const gap of gaps) console.warn(`Unposted gap for story ${storyId}: ${gap.message}`);
    return { posted: 0, failed: gaps.map((gap) => gap.message) };
  }
  const blocks = blockIndex(content);
  const rootUid = typeof content._uid === 'string' ? content._uid : undefined;
  if (!rootUid) {
    for (const gap of gaps) console.warn(`Unposted gap for story ${storyId} (no root _uid): ${gap.message}`);
    return { posted: 0, failed: gaps.map((gap) => gap.message) };
  }
  const root: Anchor = {
    blockUid: rootUid,
    ...(typeof content.component === 'string' ? { component: content.component } : {}),
  };

  const seen = new Set<string>();
  for (const gap of gaps) {
    const { anchor, message } = anchorFor(gap, blocks, root);
    const key = [message.trim(), anchor.blockUid, anchor.fieldname ?? ''].join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);

    try {
      await postOne(storyId, anchor, message);
      result.posted++;
    } catch (error) {
      console.warn(`Could not post gap to story ${storyId}: ${String(error)} | gap: ${message}`);
      result.failed.push(message);
    }
  }
  return result;
}
