import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

import { resolveStoryblokSpaceId } from '../storyblok-config.js';
import { callTool } from '../gateway.js';
import { translatedFieldCount } from '../story-checks.js';
import { getStory } from '../storyblok-reads.js';

// The Storyblok MCP server doesn't expose AI translate, so its Management API
// endpoints are published on the Gateway as the SBMAPI target. Cedar allows
// these tools only for this deployment's space (allowStoryblokAiTools), and the
// Gateway attaches the PAT. The model never sees the raw tools (they're
// filtered out of its MCP client): it calls this wrapper, which adds the
// per-story queue and the wait.
const TRIGGER_TOOL = 'SBMAPI___aiTranslateStory';
const POLL_TOOL = 'SBMAPI___getBackgroundTask';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 120_000;
// The Gateway reports a background task that no longer exists as a generic tool
// error, the same as a transient failure. Only this many in a row, with no new
// translated fields on the story, count as the job having ended.
const MAX_POLL_ERRORS = 3;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// One AI-translate job per story at a time.
//
// Storyblok runs these as background jobs that write straight onto the story.
// Two in flight against the same story race each other and one locale silently
// ends up with nothing: with de and ja triggered together, one can land every
// translated value and the other none. Callers translate several locales by
// making several calls, so queue them here rather than relying on the model to
// remember to wait.
const inFlightByStory = new Map<number, Promise<unknown>>();

/**
 * Count `__i18n__<lang>` keys actually present on the story right now.
 *
 * Ground truth for "did this translation happen", used whenever the background
 * task stops being observable. Returns null if the story could not be read, so
 * callers can distinguish "no translations" from "could not check".
 */
async function countTranslatedFields(storyId: number, lang: string): Promise<number | null> {
  try {
    return translatedFieldCount((await getStory(storyId)).content, lang);
  } catch {
    return null;
  }
}

interface TranslateInput {
  story_id: number;
  lang: string;
  overwrite: boolean;
  code?: string | undefined;
}

/**
 * Trigger one AI-translate job and wait for it to finish.
 *
 * Storyblok returns a background_task_id rather than the translated content,
 * so this polls that job. Two things the task record cannot tell us reliably:
 *
 *  - It is deleted once the job ends, so "gone" is ambiguous. A job that
 *    finished and a job that died look identical, and with a 2s poll interval
 *    the last progress seen is often nowhere near 100 even on a clean run.
 *  - The progress number can stall well behind the writes.
 *
 * So whenever the task stops being observable, ask the story itself. The
 * `__i18n__<lang>` keys on the content are the only authority on whether the
 * translation happened.
 */
async function translateOnce({ story_id: storyId, lang, overwrite, code }: TranslateInput): Promise<string> {
  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) return 'Could not resolve the Storyblok space id -- cannot call ai_translate.';

  // Fields already present before we start, so a pre-existing translation is
  // not mistaken for work this call did.
  const before = await countTranslatedFields(storyId, lang);

  let taskId: unknown;
  try {
    const started = await callTool<{ background_task_id?: unknown }>(TRIGGER_TOOL, {
      space_id: spaceId,
      story_id: storyId,
      lang,
      overwrite,
      ...(code ? { code } : {}),
    });
    taskId = started.background_task_id;
  } catch (error) {
    console.warn(`ai_translate trigger failed: ${String(error)}`);
    return `ai_translate trigger failed: ${String(error)}`;
  }
  if (typeof taskId !== 'number') return `ai_translate did not return a background_task_id: ${JSON.stringify(taskId)}`;

  const deadline = Date.now() + MAX_POLL_MS;
  let sawProgress = 0;
  let pollErrors = 0;

  const completed = (count: number | null) =>
    `Translation to '${lang}' completed for story ${storyId}` +
    (count === null
      ? '. Could not re-read the story to confirm -- re-fetch it and check for __i18n__ fields.'
      : ` -- the story now carries ${count} '__i18n__${lang}' field(s)` +
        (before === null ? '' : ` (was ${before})`) +
        '. Re-fetch the story if you need the translated text itself.');

  /** Decide from the story's own content once the task is no longer observable. */
  const verdictFromStory = async (why: string): Promise<string> => {
    const after = await countTranslatedFields(storyId, lang);
    if (after === null) {
      return (
        `${why} and the story could not be re-read to confirm. Re-fetch story ${storyId} ` +
        `and check for '__i18n__${lang}' fields before reporting this locale either way.`
      );
    }
    if (after > 0 && (before === null || after > before)) return completed(after);
    if (after > 0) {
      return (
        `${why}. Story ${storyId} carries ${after} '__i18n__${lang}' field(s), the same as ` +
        'before this call, so this run does not appear to have added anything. Treat the ' +
        'locale as unchanged and report it honestly.'
      );
    }
    return (
      `${why}, and story ${storyId} has no '__i18n__${lang}' fields at all. The translation ` +
      'did not happen. Do not report this locale as done; retry it or flag it as missing.'
    );
  };

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);

    let progress: number | undefined;
    try {
      const body = await callTool<{ background_task?: { progress?: number } }>(POLL_TOOL, {
        space_id: spaceId,
        task_id: taskId,
      });
      progress = body.background_task?.progress;
      pollErrors = 0;
    } catch (error) {
      // Usually the task record is gone because the job ended; sometimes it's
      // a blip. The story tells the two apart: new fields mean it finished.
      pollErrors++;
      const after = await countTranslatedFields(storyId, lang);
      if (after !== null && after > 0 && (before === null || after > before)) return completed(after);
      if (pollErrors >= MAX_POLL_ERRORS) {
        return verdictFromStory(
          `The translation job for story ${storyId} is no longer available ` +
            `(last seen progress: ${sawProgress}%; ${String(error)})`,
        );
      }
      continue;
    }

    sawProgress = progress ?? sawProgress;
    if (sawProgress >= 100) return completed(await countTranslatedFields(storyId, lang));
  }

  return verdictFromStory(
    `Timed out after ${Math.round(MAX_POLL_MS / 1000)}s waiting for the translation job on ` +
      `story ${storyId} to reach 100% (last seen progress: ${sawProgress}%)`,
  );
}

export const aiTranslateStory = tool({
  name: 'ai_translate_story',
  description:
    "Translate a story into a target language using Storyblok's AI-translate endpoint and wait " +
    'for it to finish. Storyblok saves translated fields onto the story as ' +
    '`<field>__i18n__<lang>` keys, so no follow-up updateStory call is needed. This tool ' +
    'confirms the outcome by re-reading the story and counting those keys, and its return ' +
    'message states what it actually found -- trust that over any progress number. Calls ' +
    'against the same story are queued automatically, so translating several locales is safe, ' +
    'but each call waits for the one before it.',
  inputSchema: z.object({
    story_id: z.number().int().describe('The numeric id of the story to translate.'),
    lang: z.string().describe('Official language code, e.g. "de", "ja".'),
    overwrite: z
      .boolean()
      .default(true)
      .describe('Whether to replace any existing translated values for this language.'),
    code: z
      .string()
      .optional()
      .describe(
        'Custom language identifier from Space Settings, only if this space uses a custom ' +
          'locale code different from the official language code.',
      ),
  }),
  callback: async (input) => {
    // Queue behind any job already running against this story -- see
    // inFlightByStory. Registering before awaiting means a third caller queues
    // behind the second, not alongside it.
    const previous = inFlightByStory.get(input.story_id);
    const run = (previous ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => translateOnce(input));
    inFlightByStory.set(input.story_id, run);

    try {
      return await run;
    } finally {
      if (inFlightByStory.get(input.story_id) === run) inFlightByStory.delete(input.story_id);
    }
  },
});
