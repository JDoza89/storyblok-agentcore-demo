import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

import type { RunTracker } from '../run-tracker.js';

/**
 * Build the tool the agent uses to record a gap for a human reviewer.
 *
 * Recording, not posting: the harness posts every recorded gap as a comment on
 * the story once the run is over, after verification and any repair turn. A gap
 * posted the moment it was noticed would stay on the story even if the agent
 * resolved it three calls later, and a run that never gets as far as creating
 * a story has nothing to comment on.
 */
export function makeFlagGapTool(tracker: RunTracker) {
  return tool({
    name: 'flag_gap',
    description:
      'Record a gap a human reviewer needs to know about: something the brief left out, a ' +
      "related product you couldn't resolve, a missing asset, a field you left empty, a locale " +
      'that is not enabled. Call it as soon as you find the gap. The harness posts every flagged ' +
      'gap as a comment on the story when the run ends. When the gap is about one field of one ' +
      "block, pass that block's `_uid`, its component name, and the field name so the comment is " +
      'pinned there; otherwise pass only the message. Still list every gap in your final summary.',
    inputSchema: z.object({
      message: z.string().min(1).describe('What is missing or uncertain, and what a human should do about it.'),
      component: z.string().optional().describe('Component name of the block the gap is about, e.g. "specTable".'),
      block_uid: z.string().optional().describe("That block's `_uid` in the story content."),
      fieldname: z.string().optional().describe('The field on that block, e.g. "specs".'),
    }),
    callback: ({ message, component, block_uid: blockUid, fieldname }) => {
      tracker.gaps.push({
        message,
        ...(component ? { component } : {}),
        ...(blockUid ? { blockUid } : {}),
        ...(fieldname ? { fieldname } : {}),
      });
      return `Gap recorded (${tracker.gaps.length} so far). It will be posted as a comment on the story when the run ends.`;
    },
  });
}
