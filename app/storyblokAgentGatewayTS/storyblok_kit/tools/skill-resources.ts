import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { tool } from '@strands-agents/sdk';
import { z } from 'zod';

const MAX_BYTES = 256 * 1024;

/**
 * Build the tool that reads a skill's bundled resource files.
 *
 * `AgentSkills` lists each skill's resource files but gives the agent no way to
 * open them, and several Storyblok skills are written expecting exactly that
 * ("read the reference for a resource before your first call"). Without this
 * the references are dangling pointers and the skill silently loses half its
 * content — the same failure as flattening SKILL.md, just better disguised.
 *
 * Reads are confined to the synced skills root. The runtime's filesystem holds
 * nothing else the model should reach, so the guard is a real boundary rather
 * than a formality: the resolved path must stay inside the root, which also
 * rules out `..` traversal and symlinks pointing outward.
 */
export function makeReadSkillResourceTool(skillsRoot: string) {
  return tool({
    name: 'read_skill_resource',
    description:
      "Read one of a skill's bundled resource/reference files (e.g. " +
      "'storyblok-use-mcp/references/stories.md'). Use this whenever an activated skill " +
      'points you at a reference file before performing an operation. Paths are relative ' +
      'to the skills root and are listed in the skill activation response.',
    inputSchema: z.object({
      resource_path: z
        .string()
        .describe(
          "Path relative to the skills root, e.g. 'storyblok-use-mcp/references/stories.md'. " +
            'Include the skill directory name as the first segment.',
        ),
    }),
    callback: async ({ resource_path: resourcePath }) => {
      let root: string;
      try {
        root = await fs.realpath(skillsRoot);
      } catch {
        return `The skills directory is unavailable (${skillsRoot}).`;
      }

      const target = path.resolve(root, resourcePath);
      if (target !== root && !target.startsWith(root + path.sep)) {
        return `Refused: '${resourcePath}' resolves outside the skills directory.`;
      }

      let real: string;
      try {
        real = await fs.realpath(target);
      } catch {
        return `No such skill resource: '${resourcePath}'.`;
      }
      if (real !== root && !real.startsWith(root + path.sep)) {
        return `Refused: '${resourcePath}' resolves outside the skills directory.`;
      }

      const stat = await fs.stat(real);
      if (stat.isDirectory()) {
        const entries = await fs.readdir(real);
        return `'${resourcePath}' is a directory. It contains: ${entries.join(', ')}`;
      }
      if (stat.size > MAX_BYTES) {
        return `'${resourcePath}' is ${stat.size} bytes, larger than the ${MAX_BYTES}-byte limit.`;
      }
      return fs.readFile(real, 'utf8');
    },
  });
}
