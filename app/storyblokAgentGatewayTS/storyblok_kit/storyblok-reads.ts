import { callGateway, READONLY_TOOL } from './gateway.js';

/**
 * The harness's own reads: building the session's space context, checking a
 * write before it goes out, and reading a story back after it lands. They go
 * through the Gateway MCP target (see gateway.ts), and every operation used here
 * is on Cedar's readonly allowlist.
 *
 * Read-only by construction: the only tool this module calls is
 * `execute_readonly`. The two Storyblok calls that don't go through MCP are AI
 * branding and AI translate, which the MCP server doesn't expose.
 */

export interface StoryblokStory {
  id: number;
  uuid: string;
  name: string;
  slug: string;
  full_slug: string;
  published: boolean;
  unpublished_changes?: boolean;
  content: Record<string, unknown>;
  stage?: { workflow_stage_id?: number | null } | null;
}

export interface WorkflowStage {
  id: number;
  name: string;
  position: number;
  allow_publish: boolean;
  allow_admin_publish: boolean;
  workflow_id: number;
}

export interface ComponentField {
  type: string;
  display_name?: string;
  description?: string;
  translatable?: boolean;
  required?: boolean;
  component_whitelist?: string[];
  restrict_components?: boolean;
  source?: string;
  folder_slug?: string;
  filter_content_type?: string[];
  keys?: string[];
  options?: { name: string; value: string }[];
  default_value?: unknown;
}

export interface Component {
  name: string;
  is_root: boolean;
  schema: Record<string, ComponentField>;
}

export interface Folder {
  id: number;
  name: string;
  full_slug: string;
}

function read<T>(operation: string, parameters: Record<string, unknown> = {}, fields?: string[]): Promise<T> {
  return callGateway<T>({ tool: READONLY_TOOL, operation, parameters, ...(fields ? { fields } : {}), retry: true });
}

export async function getStory(storyId: number): Promise<StoryblokStory> {
  return (await read<{ story: StoryblokStory }>('getStoryById', { id: storyId })).story;
}

export async function listComponents(): Promise<Component[]> {
  return (
    await read<{ components: Component[] }>('listManagementComponents', {}, [
      'components.name',
      'components.is_root',
      'components.schema',
    ])
  ).components;
}

export async function listWorkflowStages(): Promise<WorkflowStage[]> {
  return (await read<{ workflow_stages: WorkflowStage[] }>('listWorkflowStages')).workflow_stages;
}

export async function listFolders(): Promise<Folder[]> {
  return (
    await read<{ stories: Folder[] }>('listStories', { folder_only: true, per_page: 100 }, [
      'stories.id',
      'stories.name',
      'stories.full_slug',
    ])
  ).stories;
}

export async function listLanguages(): Promise<string[]> {
  const body = await read<{ space?: { languages?: { code: string }[] } }>('getSpace', {}, ['space.languages']);
  return (body.space?.languages ?? []).map((language) => language.code);
}
