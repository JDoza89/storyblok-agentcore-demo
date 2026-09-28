import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

import {
  resolveManagementApiBase,
  resolveStoryblokPat,
  resolveStoryblokSpaceId,
} from '../credentials.js';

const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_MS = 120_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// One AI-translate job per story at a time.
//
// Storyblok runs these as background jobs that write straight onto the story.
// Two in flight against the same story race each other and one locale silently
// ends up with nothing -- observed on Aurora Summit 1, where de and ja were
// triggered together, ja landed 29 translated values and de landed zero.
// Callers translate several locales by making several calls, so queue them here
// rather than relying on the model to remember to wait.
const inFlightByStory = new Map<number, Promise<unknown>>();

/**
 * Count `__i18n__<lang>` keys actually present on the story right now.
 *
 * Ground truth for "did this translation happen", used whenever the background
 * task stops being observable. Returns null if the story could not be read, so
 * callers can distinguish "no translations" from "could not check".
 */
async function countTranslatedFields(
  managementApiBase: string,
  spaceId: number,
  storyId: number,
  lang: string,
  headers: Record<string, string>,
): Promise<number | null> {
  try {
    const response = await fetch(`${managementApiBase}/spaces/${spaceId}/stories/${storyId}`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { story?: { content?: unknown } };
    if (body.story?.content === undefined) return null;
    const matches = JSON.stringify(body.story.content).match(
      new RegExp(`"[A-Za-z0-9_]+__i18n__${lang}"`, 'g'),
    );
    return matches?.length ?? 0;
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
 *  - It is deleted once the job ends, so a 404 is ambiguous. A job that
 *    finished and a job that died look identical, and with a 2s poll interval
 *    the last progress we saw is often nowhere near 100 even on a clean run.
 *    An earlier version reported failure on that basis and was wrong: the run
 *    that "disappeared at 5%" had in fact written 29 translated fields.
 *  - The progress number can stall well behind the writes.
 *
 * So whenever the task stops being observable, ask the story itself. The
 * `__i18n__<lang>` keys on the content are the only authority on whether the
 * translation happened.
 */
async function translateOnce({
  story_id: storyId,
  lang,
  overwrite,
  code,
}: TranslateInput): Promise<string> {
  const token = await resolveStoryblokPat();
  if (!token) return 'Could not resolve the Storyblok credential -- cannot call ai_translate.';

  const spaceId = resolveStoryblokSpaceId();
  if (spaceId === null) return 'Could not resolve the Storyblok space id -- cannot call ai_translate.';

  const managementApiBase = resolveManagementApiBase();
  const headers = { Authorization: token, 'Content-Type': 'application/json' };
  const body: Record<string, unknown> = { lang, overwrite };
  if (code) body.code = code;

  // Fields already present before we start, so a pre-existing translation is
  // not mistaken for work this call did.
  const before = await countTranslatedFields(managementApiBase, spaceId, storyId, lang, headers);

  let triggerResponse: Response;
  try {
    triggerResponse = await fetch(
      `${managementApiBase}/spaces/${spaceId}/stories/${storyId}/ai_translate`,
      { method: 'PUT', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000) },
    );
    if (!triggerResponse.ok) {
      throw new Error(`HTTP ${triggerResponse.status} ${triggerResponse.statusText}`);
    }
  } catch (error) {
    console.warn(`ai_translate trigger failed: ${String(error)}`);
    return `ai_translate trigger failed: ${String(error)}`;
  }

  const triggerText = await triggerResponse.text();
  let taskId: unknown;
  try {
    taskId = (JSON.parse(triggerText) as { background_task_id?: unknown }).background_task_id;
  } catch {
    taskId = undefined;
  }
  if (!taskId) return `ai_translate did not return a background_task_id: ${triggerText}`;

  const taskUrl = `${managementApiBase}/spaces/${spaceId}/background_tasks/${taskId}`;
  const deadline = Date.now() + MAX_POLL_MS;
  let sawProgress = 0;

  const completed = (count: number | null) =>
    `Translation to '${lang}' completed for story ${storyId}` +
    (count === null
      ? '. Could not re-read the story to confirm -- re-fetch it and check for __i18n__ fields.'
      : ` -- the story now carries ${count} '__i18n__${lang}' field(s)` +
        (before === null ? '' : ` (was ${before})`) +
        '. Re-fetch the story if you need the translated text itself.');

  /** Decide from the story's own content once the task is no longer observable. */
  const verdictFromStory = async (why: string): Promise<string> => {
    const after = await countTranslatedFields(managementApiBase, spaceId, storyId, lang, headers);
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

    let pollResponse: Response;
    try {
      pollResponse = await fetch(taskUrl, { headers, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      console.warn(`ai_translate poll request failed: ${String(error)}`);
      continue;
    }

    // The task record is deleted when the job ends, so this is expected on a
    // successful run as often as a failed one. The story decides.
    if (pollResponse.status === 404) {
      return verdictFromStory(
        `The translation job for story ${storyId} is no longer available ` +
          `(last seen progress: ${sawProgress}%)`,
      );
    }

    try {
      const task = ((await pollResponse.json()) as { background_task?: { progress?: number } })
        .background_task;
      sawProgress = task?.progress ?? sawProgress;
    } catch (error) {
      console.warn(`ai_translate poll response was not JSON: ${String(error)}`);
      continue;
    }
    if (sawProgress >= 100) {
      return completed(
        await countTranslatedFields(managementApiBase, spaceId, storyId, lang, headers),
      );
    }
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
