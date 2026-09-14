import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

import {
  resolveManagementApiBase,
  resolveStoryblokPat,
  resolveStoryblokSpaceId,
} from '../credentials.js';

/**
 * Fetch the space's real AI Branding settings (industry, product, audience,
 * voice, and related fields) directly from Storyblok's Management API.
 *
 * Uses the agent's normal Storyblok credential (the same PAT resolved for every
 * other Storyblok call), not a separate session token -- this is the real,
 * durable source of truth, not a stopgap. If this fails, fall back to the
 * story-based fetch described in the brand-guidelines skill.
 */
export const fetchAiBrandingGuidelines = tool({
  name: 'fetch_ai_branding_guidelines',
  description:
    "Fetch the space's real AI Branding settings (industry, product, audience, voice, and " +
    "related fields) directly from Storyblok's Management API. This is the durable source of " +
    'truth for brand guidelines. If it fails, fall back to the guidelines story described in ' +
    'the brand-guidelines skill.',
  inputSchema: z.object({}),
  callback: async () => {
    const token = await resolveStoryblokPat();
    if (!token) {
      return 'Could not resolve the Storyblok credential -- cannot fetch AI Branding settings this way.';
    }

    const spaceId = resolveStoryblokSpaceId();
    if (spaceId === null) {
      return 'Could not resolve the Storyblok space id -- cannot fetch AI Branding settings this way.';
    }

    try {
      const response = await fetch(
        `${resolveManagementApiBase()}/spaces/${spaceId}/ai_branding_rules`,
        { headers: { Authorization: token }, signal: AbortSignal.timeout(10_000) },
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const body = (await response.json()) as { ai_branding_rule?: unknown };
      return (body.ai_branding_rule ?? {}) as Record<string, unknown>;
    } catch (error) {
      console.warn(`Failed to fetch AI Branding settings: ${String(error)}`);
      return (
        `Failed to fetch AI Branding settings (${String(error)}). Fall back to the ` +
        'guidelines story described in the brand-guidelines skill.'
      );
    }
  },
});
