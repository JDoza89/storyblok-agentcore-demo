import { getAiBrandingRules } from './ai-branding.js';
import {
  listComponents,
  listFolders,
  listLanguages,
  listWorkflowStages,
  type Component,
  type ComponentField,
  type Folder,
  type WorkflowStage,
} from './storyblok-reads.js';

/**
 * Everything about the space that is the same on every run, read live once per
 * session by code instead of discovered by the model one search -> describe ->
 * execute round at a time.
 *
 * "Live" is the point that stays from v1's skill: nothing here is a snapshot
 * checked into the repo, so a schema edit in Storyblok takes effect on the next
 * session. What changes is who does the reading. The model used to spend its
 * first dozen or so tool calls on this, and every one of those results stayed
 * in context for the rest of the run.
 *
 * The same object is what the launch-invariant hooks and the verifier check
 * writes against, so the model and the guards agree on one reading of the
 * schema.
 */

export const CONTENT_TYPE = 'productPage';
export const REVIEW_STAGE_NAME = 'Reviewing';

export interface ReferenceField {
  field: string;
  multiple: boolean;
  folderSlug?: string;
  contentTypes?: string[];
}

export interface SpaceContext {
  spaceId: number;
  region: string;
  /** The stage every story must sit in. Null only if the space has no usable stage. */
  reviewStage: WorkflowStage | null;
  /** Set when no stage is named exactly `Reviewing` and a fallback was chosen. */
  reviewStageWarning?: string;
  /** Components reachable from the content type's whitelists, by name. */
  components: Map<string, Component>;
  /** Story-reference fields per component name -- the fields that must hold uuids. */
  referenceFields: Map<string, ReferenceField[]>;
  /** The content type's SEO fields, read from its SEO tab or, failing that, by name. */
  seoFields: string[];
  languages: string[];
  folders: Folder[];
  branding: { ok: true; rules: Record<string, unknown> } | { ok: false; error: string };
  /** Non-fatal problems the model should flag in its summary. */
  warnings: string[];
}

function isPublishingStage(stage: WorkflowStage): boolean {
  return stage.allow_publish || stage.allow_admin_publish;
}

/**
 * Pick the review stage by exact name, never by position or by how finished a
 * name sounds -- "Ready to Publish" in this space has allow_admin_publish: true,
 * and a v1 run once picked it for exactly that reason.
 */
function resolveReviewStage(stages: WorkflowStage[]): Pick<SpaceContext, 'reviewStage' | 'reviewStageWarning'> {
  const named = stages.find((stage) => stage.name === REVIEW_STAGE_NAME);
  if (named && !isPublishingStage(named)) return { reviewStage: named };

  const fallback = stages
    .filter((stage) => !isPublishingStage(stage))
    .sort((a, b) => b.position - a.position)[0];
  const why = named
    ? `The stage named '${REVIEW_STAGE_NAME}' permits publishing, so it was not used.`
    : `No workflow stage is named '${REVIEW_STAGE_NAME}'.`;
  if (!fallback) {
    return { reviewStage: null, reviewStageWarning: `${why} No non-publishing stage exists either.` };
  }
  return {
    reviewStage: fallback,
    reviewStageWarning: `${why} Using the closest non-publishing stage, '${fallback.name}', instead.`,
  };
}

/** Walk every whitelist reachable from the content type, including nested bloks and richtext bloks. */
function reachableComponents(all: Component[], rootName: string): Map<string, Component> {
  const byName = new Map(all.map((component) => [component.name, component]));
  const reachable = new Map<string, Component>();
  const queue = [rootName];
  while (queue.length > 0) {
    const name = queue.shift()!;
    const component = byName.get(name);
    if (!component || reachable.has(name)) continue;
    reachable.set(name, component);
    for (const field of Object.values(component.schema)) {
      for (const child of field.component_whitelist ?? []) queue.push(child);
    }
  }
  return reachable;
}

export function isStoryReference(field: ComponentField): boolean {
  return (field.type === 'options' || field.type === 'option') && field.source === 'internal_stories';
}

function collectReferenceFields(components: Map<string, Component>): Map<string, ReferenceField[]> {
  const result = new Map<string, ReferenceField[]>();
  for (const [name, component] of components) {
    const fields = Object.entries(component.schema)
      .filter(([, field]) => isStoryReference(field))
      .map(([fieldName, field]) => ({
        field: fieldName,
        multiple: field.type === 'options',
        ...(field.folder_slug ? { folderSlug: field.folder_slug } : {}),
        ...(field.filter_content_type ? { contentTypes: field.filter_content_type } : {}),
      }));
    if (fields.length > 0) result.set(name, fields);
  }
  return result;
}

function collectSeoFields(contentType: Component | undefined): string[] {
  if (!contentType) return [];
  const schema = contentType.schema;
  const seoTab = Object.values(schema).find(
    (field) => field.type === 'tab' && /seo/i.test(field.display_name ?? ''),
  );
  if (seoTab?.keys?.length) return seoTab.keys.filter((key) => key in schema);
  return Object.keys(schema).filter((key) => /^(meta_|og_|seo)/i.test(key));
}

/** One line per field: `name (type, i18n, required) -- description`. */
function describeField(name: string, field: ComponentField): string {
  const traits: string[] = [field.type];
  if (field.component_whitelist?.length) traits.push(`allows: ${field.component_whitelist.join(', ')}`);
  if (isStoryReference(field)) {
    traits.push(field.type === 'options' ? 'story uuids[]' : 'one story uuid');
    if (field.folder_slug) traits.push(`folder ${field.folder_slug}`);
    if (field.filter_content_type?.length) traits.push(`type ${field.filter_content_type.join('|')}`);
  } else if (field.options?.length) {
    traits.push(`one of: ${field.options.map((option) => option.value).join('|')}`);
  }
  if (field.translatable) traits.push('translatable');
  if (field.required) traits.push('required');
  const description = field.description ? ` -- ${field.description}` : '';
  return `  - \`${name}\` (${traits.join(', ')})${description}`;
}

export function renderSpaceContext(ctx: SpaceContext): string {
  const lines: string[] = [];
  lines.push(`Space ${ctx.spaceId}, region \`${ctx.region}\`. Languages enabled: ${ctx.languages.join(', ') || '(default only)'}.`);
  lines.push('');

  if (ctx.reviewStage) {
    lines.push(`**Review stage:** \`${ctx.reviewStage.name}\`, id \`${ctx.reviewStage.id}\` (non-publishing, confirmed by the harness).`);
  } else {
    lines.push('**Review stage:** none usable. Create or update nothing; report this and stop.');
  }
  if (ctx.reviewStageWarning) lines.push(`Warning: ${ctx.reviewStageWarning}`);
  lines.push('');

  lines.push(`**Content model.** The components below are exactly what \`${CONTENT_TYPE}\` and its nested whitelists allow. Use no other component and no other field name.`);
  const ordered = [CONTENT_TYPE, ...[...ctx.components.keys()].filter((name) => name !== CONTENT_TYPE).sort()];
  for (const name of ordered) {
    const component = ctx.components.get(name);
    if (!component) continue;
    lines.push(`- \`${name}\`${name === CONTENT_TYPE ? ' (content type)' : ''}`);
    for (const [fieldName, field] of Object.entries(component.schema)) {
      if (field.type === 'tab') continue;
      lines.push(describeField(fieldName, field));
    }
  }
  lines.push('');
  lines.push(`**SEO fields on \`${CONTENT_TYPE}\`:** ${ctx.seoFields.map((field) => `\`${field}\``).join(', ') || '(none found)'}.`);
  lines.push('');

  lines.push('**Folders:**');
  for (const folder of ctx.folders) lines.push(`- \`${folder.full_slug}\` id \`${folder.id}\` (${folder.name})`);
  lines.push('');

  lines.push('**Brand guidelines (AI Branding settings, fetched live this session):**');
  if (ctx.branding.ok) {
    lines.push('```json', JSON.stringify(ctx.branding.rules, null, 2), '```');
  } else {
    lines.push(`Could not be fetched: ${ctx.branding.error}. Follow the fallback in the \`brand-guidelines\` skill.`);
  }

  if (ctx.warnings.length > 0) {
    lines.push('', '**Flag these in your summary:**', ...ctx.warnings.map((warning) => `- ${warning}`));
  }
  return lines.join('\n');
}

/**
 * Build the session's space context. Schema and stages are required -- the
 * hooks cannot guard writes without them, so a failure here fails the session
 * rather than letting the model run unguarded. Branding and languages are
 * best-effort, surfaced as warnings.
 */
export async function loadSpaceContext(spaceId: number, region: string): Promise<SpaceContext> {
  const warnings: string[] = [];
  const [components, stages, folders, branding, languages] = await Promise.all([
    listComponents(),
    listWorkflowStages(),
    listFolders().catch((error: unknown) => {
      warnings.push(`Folders could not be read (${String(error)}); find the products folder with listStories.`);
      return [] as Folder[];
    }),
    getAiBrandingRules().then(
      (rules) =>
        Object.keys(rules).length > 0
          ? ({ ok: true, rules } as const)
          : ({ ok: false, error: 'the space has no AI Branding settings configured' } as const),
      (error: unknown) => ({ ok: false, error: String(error) }) as const,
    ),
    listLanguages().catch((error: unknown) => {
      warnings.push(`Enabled languages could not be read (${String(error)}); don't assume a locale is missing.`);
      return [] as string[];
    }),
  ]);

  const reachable = reachableComponents(components, CONTENT_TYPE);
  if (!reachable.has(CONTENT_TYPE)) {
    throw new Error(`The space has no '${CONTENT_TYPE}' component -- refusing to start a session without it.`);
  }
  for (const component of reachable.values()) {
    for (const field of Object.values(component.schema)) {
      for (const child of field.component_whitelist ?? []) {
        if (!components.some((candidate) => candidate.name === child)) {
          warnings.push(`\`${component.name}\` whitelists \`${child}\`, which does not exist in the space.`);
        }
      }
    }
  }

  const review = resolveReviewStage(stages);
  if (review.reviewStageWarning) warnings.push(review.reviewStageWarning);
  if (!branding.ok) warnings.push(`Brand guidelines could not be fetched (${branding.error}); all copy needs a human voice pass.`);

  return {
    spaceId,
    region,
    ...review,
    components: reachable,
    referenceFields: collectReferenceFields(reachable),
    seoFields: collectSeoFields(reachable.get(CONTENT_TYPE)),
    languages,
    folders,
    branding,
    warnings,
  };
}
