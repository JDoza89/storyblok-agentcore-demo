import { getStory, type StoryblokStory } from './storyblok-reads.js';
import type { RunTracker } from './run-tracker.js';
import { CONTENT_TYPE, type SpaceContext } from './space-context.js';
import {
  bodyLength,
  invalidReferences,
  seoStatus,
  stageOf,
  translatedFieldCount,
} from './story-checks.js';

/**
 * End-of-run verification: code reads the story back and decides whether the
 * run did what the skill requires, instead of trusting the model's summary.
 *
 * v1's skill spent a whole section telling the model that a 200 is not proof
 * and it must re-fetch before claiming success. The model did that most of the
 * time. This does it every time, and the AGENT_RESULT line is built from what
 * it finds.
 */

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
  /** A critical failure means the run failed, whatever else passed. */
  critical: boolean;
}

export type LocaleStatus = 'complete' | 'partial' | 'missing';

export interface Verification {
  storyId: number;
  story: StoryblokStory | null;
  checks: Check[];
  locales: Record<string, LocaleStatus>;
}

export async function verifyStory(storyId: number, ctx: SpaceContext, tracker: RunTracker): Promise<Verification> {
  const locales = [...tracker.locales];
  let story: StoryblokStory;
  try {
    story = await getStory(storyId);
  } catch (error) {
    return {
      storyId,
      story: null,
      checks: [{ name: 'readable', ok: false, detail: `could not read story ${storyId}: ${String(error)}`, critical: true }],
      locales: Object.fromEntries(locales.map((lang) => [lang, 'missing' as const])),
    };
  }

  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string, critical = false) => checks.push({ name, ok, detail, critical });

  add('not published', !story.published, story.published ? 'the story is published' : 'unpublished', true);

  const blocks = bodyLength(story.content);
  add('body present', (blocks ?? 0) > 0, blocks === null ? 'content.body is missing' : `${blocks} block(s)`, true);

  add(
    'content type',
    story.content.component === CONTENT_TYPE,
    `content.component is '${String(story.content.component)}'`,
    true,
  );

  const stage = stageOf(story);
  const review = ctx.reviewStage;
  const inReview = review !== null && (stage === review.id || (stage === null && tracker.stagedStories.has(storyId)));
  add(
    'review stage',
    inReview,
    review === null
      ? 'the space has no usable review stage'
      : inReview
        ? `in '${review.name}'`
        : `stage is ${String(stage)}, expected '${review.name}' (${review.id}); move it with createWorkflowStageChange`,
    // Critical: a story outside review is one a human may never look at before
    // it ships. The repair turn gets one chance to move it; after that the run
    // reports failed rather than created.
    true,
  );

  const badRefs = invalidReferences(story.content, ctx);
  add('references are uuids', badRefs.length === 0, badRefs.length === 0 ? 'ok' : badRefs.join('; '));

  const seo = seoStatus(story.content, ctx, locales);
  const missingSeo = seo.filter((entry) => !entry.ok);
  add(
    'SEO fields',
    missingSeo.length === 0,
    missingSeo.length === 0 ? 'all set' : `empty: ${missingSeo.map((entry) => `${entry.field}[${entry.lang}]`).join(', ')}`,
  );

  const localeStatus: Record<string, LocaleStatus> = {};
  for (const lang of locales) {
    const translated = translatedFieldCount(story.content, lang);
    const seoMissing = missingSeo.some((entry) => entry.lang === lang);
    localeStatus[lang] = translated === 0 ? 'missing' : seoMissing ? 'partial' : 'complete';
    add(
      `locale ${lang}`,
      localeStatus[lang] === 'complete',
      translated === 0 ? 'no translated fields on the story' : `${translated} translated field(s)${seoMissing ? ', SEO incomplete' : ''}`,
    );
  }

  return { storyId, story, checks, locales: localeStatus };
}

export function failures(verification: Verification): Check[] {
  return verification.checks.filter((check) => !check.ok);
}

/** The follow-up turn sent to the agent when verification finds something to fix. */
export function repairPrompt(verification: Verification): string {
  const lines = failures(verification).map((check) => `- ${check.name}: ${check.detail}`);
  return [
    `The harness read story ${verification.storyId} back from Storyblok and found these problems:`,
    ...lines,
    '',
    'Fix exactly these, following the skill, and nothing else. If one cannot be fixed (for example, a ' +
      'locale that is not enabled or a published story you cannot unpublish), leave it and say why. Then ' +
      'write your final summary again, ending with the NOTES line.',
  ].join('\n');
}
