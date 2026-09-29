import { GoalLoop } from '@strands-agents/sdk/vended-plugins/goal';

import type { RunTracker } from './run-tracker.js';
import type { SpaceContext } from './space-context.js';
import { failures, repairPrompt, verifyStory, type Verification } from './verifier.js';

// One follow-up turn when verification finds a problem. Enough to fix a missed
// SEO field or a stage the model forgot; a run that is still failing after a
// targeted repair needs a human, not a third attempt.
export const MAX_REPAIR_TURNS = 1;

/** The latest verification of this invocation's story, written by the GoalLoop validator. */
export interface RunState {
  verification: Verification | null;
  /** 1 for the first attempt; GoalLoop's resume bumps it for the repair attempt. */
  attempt: number;
}

/**
 * The verify-and-repair loop, as Strands' GoalLoop plugin with a programmatic
 * validator: after each attempt, read the story back and check it. On failure,
 * GoalLoop sends the repair prompt back into the same agent loop as a user
 * message, up to one extra attempt. A run that built nothing (input that names
 * no product) has nothing to verify, so it passes.
 */
export function makeVerifyLoop(ctx: SpaceContext, tracker: RunTracker, run: RunState): GoalLoop {
  return new GoalLoop({
    goal: async () => {
      if (tracker.storyId === null) {
        run.verification = null;
        return true;
      }
      const verification = await verifyStory(tracker.storyId, ctx, tracker);
      run.verification = verification;
      const failed = failures(verification);
      if (failed.length === 0) return true;
      console.info(`Verification failed: ${failed.map((check) => check.name).join(', ')}`);
      return { passed: false, feedback: repairPrompt(verification) };
    },
    maxAttempts: MAX_REPAIR_TURNS + 1,
    // repairPrompt is already the complete follow-up message; send it as-is.
    resumePromptTemplate: (feedback) => {
      run.attempt++;
      return feedback ?? 'Re-check the story and fix anything left, then summarize again.';
    },
  });
}
