import type { Agent, InvokeArgs } from '@strands-agents/sdk';

import type { RunState } from './verify-loop.js';

/** Stream one agent turn, yielding text chunks and collecting the full text. */
export async function* streamTurn(agent: Agent, prompt: InvokeArgs, collected: { text: string }, run: RunState) {
  collected.text = '';
  let streamedAttempt = 1;
  for await (const event of agent.stream(prompt)) {
    if (
      event.type === 'modelStreamUpdateEvent' &&
      event.event?.type === 'modelContentBlockDeltaEvent' &&
      event.event.delta?.type === 'textDelta'
    ) {
      // A repair attempt runs inside the same stream, so start it on a fresh
      // paragraph: callers read it as a new reply, and the NOTES: line parser
      // needs the attempt's text to begin on its own line.
      if (run.attempt !== streamedAttempt) {
        streamedAttempt = run.attempt;
        collected.text += '\n\n';
        yield { data: '\n\n' };
      }
      collected.text += event.event.delta.text;
      yield { data: event.event.delta.text };
    }
  }
}

export function lastNotesLine(text: string): string {
  const matches = [...text.matchAll(/^NOTES:\s*(.+)$/gm)];
  return matches.length > 0 ? matches[matches.length - 1]![1]!.trim() : '';
}
