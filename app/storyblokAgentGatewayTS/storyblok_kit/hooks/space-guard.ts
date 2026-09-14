import { BeforeToolCallEvent, type Plugin } from '@strands-agents/sdk';
import type { LocalAgent } from '@strands-agents/sdk';

import { resolveStoryblokSpaceId } from '../credentials.js';

/** Recursively search a tool call's input for a space_id that isn't ours. */
function findMismatchedSpaceId(value: unknown, allowed: number | null): unknown {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findMismatchedSpaceId(item, allowed);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'space_id' && nested !== null && nested !== undefined && String(nested) !== String(allowed)) {
        return nested;
      }
      const found = findMismatchedSpaceId(nested, allowed);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Blocks any tool call that targets a Storyblok space other than the one this
 * deployment is configured for.
 *
 * This is a real, code-level guardrail, not just a prompt instruction. The
 * Storyblok credential these agents use is not scoped to a single space, so
 * nothing at the API/IAM level stops a call from reaching a different space if
 * the model ever specified one -- this hook is what actually enforces the
 * single-space restriction.
 *
 * The allowed space id is resolved from the STORYBLOK_SPACE_ID environment
 * variable (resolveStoryblokSpaceId), not hardcoded. This is what makes the hook
 * reusable across agents/deployments unchanged: point a different deployment's
 * STORYBLOK_SPACE_ID at a different space, and this hook enforces that one
 * instead, with no code change.
 *
 * If the space id can't be resolved at all, every space-scoped tool call is
 * blocked rather than let through -- fail closed, not fail open.
 *
 * Deliberately not gated on a tool-name prefix: different agents expose
 * Storyblok tools through different MCP clients with different prefixes (e.g.
 * "storyblok_" on a direct connection, "reinventdemogateway_" through a Gateway
 * target) -- a prefix check tied to one agent's wiring would silently stop
 * protecting the moment this hook is reused by another agent with a different
 * MCP setup. Instead this scans every tool call's input, regardless of tool
 * name, for a mismatched space_id -- strictly safer, and genuinely portable
 * across any agent that adds this hook.
 */
export class SpaceIdGuard implements Plugin {
  readonly name = 'storyblok-space-id-guard';
  private readonly allowedSpaceId: number | null;

  constructor() {
    this.allowedSpaceId = resolveStoryblokSpaceId();
    if (this.allowedSpaceId === null) {
      console.error(
        'Could not resolve the allowed Storyblok space id -- every ' +
          'space-scoped tool call will be blocked until this is fixed.',
      );
    }
  }

  initAgent(agent: LocalAgent): void {
    agent.addHook(BeforeToolCallEvent, (event) => {
      const toolName = event.toolUse.name ?? '';
      const badSpaceId = findMismatchedSpaceId(event.toolUse.input, this.allowedSpaceId);
      if (badSpaceId !== undefined) {
        console.warn(
          `Blocked tool call ${toolName}: space_id ${String(badSpaceId)} does not match ` +
            `the allowed space ${String(this.allowedSpaceId)}`,
        );
        event.cancel =
          `Blocked: this agent may only operate on space_id ${String(this.allowedSpaceId)}. ` +
          `The tool call specified space_id ${String(badSpaceId)}, which is not allowed.`;
      }
    });
  }
}
