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

/**
 * Translate a story into a target language using Storyblok's AI-translate
 * endpoint, and wait for it to finish.
 *
 * Storyblok processes this as a background job: triggering it returns a
 * background_task_id, not the translated content. This tool polls that job's
 * progress and only returns once it has genuinely reached 100% (confirmed
 * complete) -- Storyblok's backend saves the translated fields directly onto the
 * story itself at that point, as `<field>__i18n__<lang>` keys alongside the
 * default-language values. No follow-up updateStory call is needed.
 *
 * This calls Storyblok's raw Management API directly with a resolved PAT,
 * independent of whatever MCP transport (direct connection or Gateway) the
 * calling agent otherwise uses for its other Storyblok tool calls.
 */
export const aiTranslateStory = tool({
  name: 'ai_translate_story',
  description:
    "Translate a story into a target language using Storyblok's AI-translate endpoint and wait " +
    'for the background job to reach 100%. Storyblok saves translated fields onto the story as ' +
    '`<field>__i18n__<lang>` keys, so no follow-up updateStory call is needed. After this ' +
    'returns successfully, re-fetch the story yourself (a plain getStory, no `language` query ' +
    "param -- it doesn't reliably surface these fields) and look for `__i18n__<lang>` suffixed " +
    'keys to confirm the actual translated text before reporting the locale as done.',
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
  callback: async ({ story_id: storyId, lang, overwrite, code }) => {
    const token = await resolveStoryblokPat();
    if (!token) return 'Could not resolve the Storyblok credential -- cannot call ai_translate.';

    const spaceId = resolveStoryblokSpaceId();
    if (spaceId === null) return 'Could not resolve the Storyblok space id -- cannot call ai_translate.';

    const managementApiBase = resolveManagementApiBase();
    const headers = { Authorization: token, 'Content-Type': 'application/json' };
    const body: Record<string, unknown> = { lang, overwrite };
    if (code) body.code = code;

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

    const completed = () =>
      `Translation to '${lang}' completed for story ${storyId}. ` +
      'Re-fetch the story and check for __i18n__ fields to confirm.';

    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);

      let pollResponse: Response;
      try {
        pollResponse = await fetch(taskUrl, { headers, signal: AbortSignal.timeout(10_000) });
      } catch (error) {
        console.warn(`ai_translate poll request failed: ${String(error)}`);
        continue;
      }

      if (pollResponse.status === 404) {
        if (sawProgress >= 100) return completed();
        return (
          `The translation job for story ${storyId} disappeared before reaching 100% ` +
          `(last seen progress: ${sawProgress}%). This usually means it did not ` +
          'complete -- do not assume the story was translated. Re-fetch the story to check ' +
          'for __i18n__ fields before reporting this locale as done either way.'
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
      if (sawProgress >= 100) return completed();
    }

    return (
      `Timed out after ${Math.round(MAX_POLL_MS / 1000)}s waiting for the translation job on story ` +
      `${storyId} to reach 100% (last seen progress: ${sawProgress}%). Do not assume it ` +
      'completed -- re-fetch the story to check for __i18n__ fields before reporting this ' +
      'locale as done either way.'
    );
  },
});
