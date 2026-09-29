import type { StoryblokStory } from './storyblok-reads.js';
import { CONTENT_TYPE, type SpaceContext } from './space-context.js';

/**
 * Pure checks over story content, shared by the launch-invariant hooks (before
 * and after a write) and the end-of-run verifier. One implementation means a
 * write the hook let through and a story the verifier passes are judged by the
 * same rules.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Content = Record<string, unknown>;

function isObject(value: unknown): value is Content {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function bodyLength(content: Content | undefined): number | null {
  const body = content?.body;
  return Array.isArray(body) ? body.length : null;
}

/**
 * Every story-reference value that is not a uuid, as `component.field[i]: value`.
 *
 * Walks the whole content tree, so a reference field inside a nested blok (a
 * `productVariant`'s `colorway`, a `testimonial`'s `customer`) is checked the
 * same as a top-level one. Which fields are references comes from the live
 * schema in the space context, never from a field's name.
 */
export function invalidReferences(content: unknown, ctx: SpaceContext, path = 'content'): string[] {
  const problems: string[] = [];
  if (Array.isArray(content)) {
    content.forEach((item, index) => problems.push(...invalidReferences(item, ctx, `${path}[${index}]`)));
    return problems;
  }
  if (!isObject(content)) return problems;

  const component = typeof content.component === 'string' ? content.component : undefined;
  for (const ref of (component && ctx.referenceFields.get(component)) || []) {
    const value = content[ref.field];
    if (value === undefined || value === null || value === '') continue;
    const values = Array.isArray(value) ? value : [value];
    values.forEach((entry, index) => {
      if (typeof entry !== 'string' || !UUID.test(entry)) {
        problems.push(`${path}.${ref.field}${Array.isArray(value) ? `[${index}]` : ''} = ${JSON.stringify(entry)}`);
      }
    });
  }
  for (const [key, nested] of Object.entries(content)) {
    if (Array.isArray(nested) || isObject(nested)) problems.push(...invalidReferences(nested, ctx, `${path}.${key}`));
  }
  return problems;
}

/** A block the harness removed because its field's whitelist doesn't allow it. */
export interface RemovedBlock {
  path: string;
  component: string;
  /** The block that holds the field, and the field, for pinning a comment there. */
  parentUid?: string;
  parentComponent: string;
  field: string;
  allowed: string[];
}

/** Every `_uid` in a content tree, so an update can tell new blocks from ones already on the story. */
export function blockUids(content: unknown, uids = new Set<string>()): Set<string> {
  if (Array.isArray(content)) {
    for (const item of content) blockUids(item, uids);
  } else if (isObject(content)) {
    if (typeof content._uid === 'string') uids.add(content._uid);
    for (const nested of Object.values(content)) blockUids(nested, uids);
  }
  return uids;
}

/**
 * Remove every block that isn't allowed where it sits, in place, and return
 * what was removed.
 *
 * The allowed set is the space's own `component_whitelist` on each `bloks` field,
 * and on each richtext field that embeds blocks, read live into the space context:
 * the components someone approved for this content type. A block outside it is
 * dropped rather than failing the write, so the page still gets created and a
 * reviewer is told what was left out. A field with no whitelist is unrestricted
 * in Storyblok, and stays unrestricted here.
 *
 * `keep` holds the `_uid`s already on the story before an update. Those blocks
 * are never removed: a block someone added by hand is theirs to keep or delete,
 * not the harness's to strip silently. Walks the whole tree, so a nested block is
 * checked against its own parent field's whitelist, not the page body's.
 */
export function stripDisallowedComponents(
  content: unknown,
  ctx: SpaceContext,
  keep: Set<string> = new Set(),
  path = 'content',
): RemovedBlock[] {
  if (!isObject(content)) return [];
  const component = typeof content.component === 'string' ? content.component : undefined;
  const schema = component ? ctx.components.get(component)?.schema : undefined;
  if (!component || !schema) return [];
  const parentUid = typeof content._uid === 'string' ? content._uid : undefined;

  const removed: RemovedBlock[] = [];
  const allowedIn = (field: string) => {
    const list = schema[field]?.component_whitelist;
    return list?.length ? list : null;
  };

  /** Filter one list of child blocks, recursing into the ones that stay. */
  const filterChildren = (children: unknown[], field: string, childPath: (i: number) => string): unknown[] => {
    const allowed = allowedIn(field);
    return children.filter((child, index) => {
      const name = isObject(child) && typeof child.component === 'string' ? child.component : undefined;
      const uid = isObject(child) && typeof child._uid === 'string' ? child._uid : undefined;
      const kept = uid !== undefined && keep.has(uid);
      if (!kept && (!name || (allowed && !allowed.includes(name)))) {
        removed.push({
          path: childPath(index),
          component: name ?? '(no component)',
          ...(parentUid ? { parentUid } : {}),
          parentComponent: component,
          field,
          allowed: allowed ?? [],
        });
        return false;
      }
      removed.push(...stripDisallowedComponents(child, ctx, keep, childPath(index)));
      return true;
    });
  };

  /** Richtext embeds blocks as `{type: "blok", attrs: {body: [...]}}` nodes, at any depth. */
  const filterRichtext = (node: unknown, field: string, nodePath: string): void => {
    if (Array.isArray(node)) {
      node.forEach((child, i) => filterRichtext(child, field, `${nodePath}[${i}]`));
      return;
    }
    if (!isObject(node)) return;
    if (node.type === 'blok' && isObject(node.attrs) && Array.isArray(node.attrs.body)) {
      node.attrs.body = filterChildren(node.attrs.body, field, (i) => `${nodePath}.body[${i}]`);
    }
    if (Array.isArray(node.content)) {
      node.content.forEach((child, i) => filterRichtext(child, field, `${nodePath}.content[${i}]`));
      // A blok node left with nothing in it would render as an empty embed.
      node.content = node.content.filter(
        (child) => !(isObject(child) && child.type === 'blok' && isObject(child.attrs) && Array.isArray(child.attrs.body) && child.attrs.body.length === 0),
      );
    }
  };

  for (const [field, definition] of Object.entries(schema)) {
    const value = content[field];
    if (definition.type === 'bloks' && Array.isArray(value)) {
      content[field] = filterChildren(value, field, (i) => `${path}.${field}[${i}]`);
    } else if (definition.type === 'richtext' && isObject(value)) {
      filterRichtext(value, field, `${path}.${field}`);
    }
  }
  return removed;
}

/**
 * Top-level content keys that held a value before and are absent after -- the
 * shape of v1's lost-body incident, where a localization step sent
 * `{"component": "page"}` and `updateStory` replaced the whole content with it.
 */
export function droppedKeys(before: Content, after: Content): string[] {
  return Object.entries(before)
    .filter(([key, value]) => !(key in after) && value !== '' && value !== null && value !== undefined)
    .map(([key]) => key);
}

function hasValue(value: unknown): boolean {
  if (typeof value === 'string') return value.trim().length > 0;
  if (isObject(value)) return typeof value.filename === 'string' && value.filename.length > 0;
  return value !== null && value !== undefined;
}

export interface SeoFieldStatus {
  field: string;
  lang: string;
  ok: boolean;
}

/**
 * SEO fields for the default language and, for translatable ones, each locale.
 * Assets are not translatable in this schema, so the share image is only
 * checked once.
 */
export function seoStatus(content: Content, ctx: SpaceContext, locales: string[]): SeoFieldStatus[] {
  const schema = ctx.components.get(CONTENT_TYPE)?.schema ?? {};
  const results: SeoFieldStatus[] = [];
  for (const field of ctx.seoFields) {
    results.push({ field, lang: 'default', ok: hasValue(content[field]) });
    if (!schema[field]?.translatable) continue;
    for (const lang of locales) {
      results.push({ field, lang, ok: hasValue(content[`${field}__i18n__${lang}`]) });
    }
  }
  return results;
}

export function translatedFieldCount(content: unknown, lang: string): number {
  return JSON.stringify(content).match(new RegExp(`"[A-Za-z0-9_]+__i18n__${lang}"`, 'g'))?.length ?? 0;
}

export function stageOf(story: StoryblokStory): number | null {
  return story.stage?.workflow_stage_id ?? null;
}

/**
 * The compact readback appended to a write's tool result, so the model learns
 * what actually landed without pulling the whole story back into context.
 */
export function renderReadback(
  story: StoryblokStory,
  ctx: SpaceContext,
  locales: string[],
  stageSetThisRun: boolean,
): string {
  const parts: string[] = [];
  const blocks = bodyLength(story.content);
  parts.push(`body: ${blocks === null ? 'MISSING' : `${blocks} block(s)`}`);

  const stage = stageOf(story);
  const reviewId = ctx.reviewStage?.id;
  if (stage !== null) {
    parts.push(`stage: ${stage === reviewId ? `${ctx.reviewStage!.name} ✓` : `${stage} ✗ (not the review stage)`}`);
  } else {
    parts.push(`stage: ${stageSetThisRun ? `${ctx.reviewStage?.name ?? '?'} (set this run)` : 'not set yet ✗'}`);
  }
  parts.push(`published: ${story.published ? 'YES ✗' : 'no'}`);

  const seo = seoStatus(story.content, ctx, locales);
  const missing = seo.filter((entry) => !entry.ok).map((entry) => `${entry.field}[${entry.lang}]`);
  parts.push(missing.length === 0 ? 'SEO: all set' : `SEO missing: ${missing.join(', ')}`);

  for (const lang of locales) parts.push(`${lang}: ${translatedFieldCount(story.content, lang)} translated field(s)`);

  const badRefs = invalidReferences(story.content, ctx);
  parts.push(badRefs.length === 0 ? 'references: all uuids' : `references NOT uuids: ${badRefs.join('; ')}`);

  return (
    `[harness readback of story ${story.id}, uuid ${story.uuid}] ${parts.join(' | ')}. ` +
    'The harness read this back from Storyblok after the write, so there is no need to re-fetch to confirm it.'
  );
}
