/**
 * Run the harness's own checks against a story from your machine.
 *
 *   npx tsx scripts/verify-story.ts <storyId> [--locales de,ja] [--context]
 *
 * The same verifier the runtime uses at the end of every run, so this is the
 * regression check for prompt and skill changes: run the agent on a brief, then
 * point this at the story it built. `--context` prints the space context the
 * agent's system prompt would carry this session.
 *
 * Reads go through the Gateway, so this needs
 * AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL (the gateway URL plus `/mcp`), AWS
 * credentials allowed to invoke it, and STORYBLOK_SPACE_ID. No Storyblok token:
 * the Gateway attaches it.
 */
import { resolveStoryblokRegion, resolveStoryblokSpaceId } from '../storyblok_kit/storyblok-config.js';
import { RunTracker } from '../storyblok_kit/run-tracker.js';
import { loadSpaceContext, renderSpaceContext } from '../storyblok_kit/space-context.js';
import { failures, verifyStory } from '../storyblok_kit/verifier.js';

const args = process.argv.slice(2);
const storyId = Number(args.find((arg) => /^\d+$/.test(arg)));
const localesFlag = args.indexOf('--locales');
const locales = localesFlag === -1 ? [] : (args[localesFlag + 1] ?? '').split(',').filter(Boolean);

const spaceId = resolveStoryblokSpaceId();
if (spaceId === null) {
  console.error('Set STORYBLOK_SPACE_ID.');
  process.exit(2);
}

const ctx = await loadSpaceContext(spaceId, resolveStoryblokRegion());
if (args.includes('--context')) console.log(renderSpaceContext(ctx), '\n');

if (!Number.isInteger(storyId) || storyId <= 0) {
  if (!args.includes('--context')) console.error('Usage: verify-story.ts <storyId> [--locales de,ja] [--context]');
  process.exit(args.includes('--context') ? 0 : 2);
}

const tracker = new RunTracker();
for (const lang of locales) tracker.locales.add(lang);
const verification = await verifyStory(storyId, ctx, tracker);

for (const check of verification.checks) {
  console.log(`${check.ok ? 'PASS' : 'FAIL'}${check.critical ? ' (critical)' : ''}  ${check.name}: ${check.detail}`);
}
console.log('\nlocales:', JSON.stringify(verification.locales));
process.exit(failures(verification).length === 0 ? 0 : 1);
