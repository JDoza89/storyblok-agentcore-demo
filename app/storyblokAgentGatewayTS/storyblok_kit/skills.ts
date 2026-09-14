/**
 * Skill fetcher — downloads s3 skills to local filesystem on first use.
 *
 * Cache directory: <tmpdir>/.agents/skills/ — an absolute path under the system
 * temp directory (honors $TMPDIR, defaults to /tmp). The runtime working
 * directory (e.g. /var/task in a CodeZip runtime) is read-only, so the cache
 * must live somewhere guaranteed-writable.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { awsRegion, createSigV4Fetch, type SignedFetch } from './sigv4.js';

const SKILLS_BASE = path.join(os.tmpdir(), '.agents', 'skills');
const S3_MAX_SIZE_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

function stableHash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

async function exists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** Remove a partially-created skill directory so retries don't see stale state. */
async function cleanup(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true });
}

async function readMap(typeDir: string): Promise<Record<string, string>> {
  try {
    return JSON.parse(await fs.readFile(path.join(typeDir, '.map.json'), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

async function writeMap(typeDir: string, mapping: Record<string, string>): Promise<void> {
  await fs.mkdir(typeDir, { recursive: true });
  await fs.writeFile(path.join(typeDir, '.map.json'), JSON.stringify(mapping));
}

/** Return the cached skill directory for a source hash, or null if not on disk. */
async function resolveCached(typeDir: string, sourceHash: string): Promise<string | null> {
  const dirName = (await readMap(typeDir))[sourceHash];
  if (dirName && (await exists(path.join(typeDir, dirName)))) return path.join(typeDir, dirName);
  return null;
}

/** Extract the skill name from SKILL.md YAML frontmatter. */
async function readSkillName(skillDir: string): Promise<string> {
  const content = await fs.readFile(path.join(skillDir, 'SKILL.md'), 'utf8');
  if (!content.startsWith('---')) {
    throw new Error(`SKILL.md in ${skillDir} has no YAML frontmatter (must start with ---)`);
  }
  const parts = content.split('---');
  if (parts.length < 3) {
    throw new Error(`SKILL.md in ${skillDir} has malformed frontmatter (missing closing ---)`);
  }
  for (const line of parts[1]!.trim().split(/\r?\n/)) {
    if (line.startsWith('name:')) {
      const name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '');
      if (name) return name;
    }
  }
  throw new Error(`SKILL.md in ${skillDir} is missing a 'name' field in frontmatter`);
}

/** Pick a unique directory name, appending a hash suffix on collision. */
async function pickDirName(typeDir: string, name: string, sourceHash: string): Promise<string> {
  return (await exists(path.join(typeDir, name))) ? `${name}-${sourceHash.slice(0, 8)}` : name;
}

/**
 * Validate SKILL.md, rename the temp dir to the skill's declared name, and
 * update the map. Throws if SKILL.md is missing or has invalid frontmatter.
 */
async function renameAndCacheSkill(
  typeDir: string,
  tempDir: string,
  sourceHash: string,
  sourceLabel: string,
): Promise<string> {
  if (!(await exists(path.join(tempDir, 'SKILL.md')))) {
    await cleanup(tempDir);
    throw new Error(`No SKILL.md found in fetched skill (source: ${sourceLabel})`);
  }

  const name = await readSkillName(tempDir);
  const finalDir = path.join(typeDir, await pickDirName(typeDir, name, sourceHash));
  if (finalDir !== tempDir) await fs.rename(tempDir, finalDir);

  const mapping = await readMap(typeDir);
  mapping[sourceHash] = path.basename(finalDir);
  await writeMap(typeDir, mapping);
  return finalDir;
}

/**
 * S3 access goes over signed REST rather than @aws-sdk/client-s3.
 *
 * The AgentCore Node packager marks `@aws-sdk/client-s3` as esbuild-external
 * and does not copy it into the deployment zip, so importing it produces a
 * bundle that throws MODULE_NOT_FOUND on the first invocation. Everything else
 * is bundled, so signing these two calls by hand is what actually deploys.
 */
function s3Client(): SignedFetch {
  return createSigV4Fetch({ service: 's3', uriEscapePath: false });
}

function s3Origin(bucket: string): string {
  return `https://${bucket}.s3.${awsRegion()}.amazonaws.com`;
}

/** Encode an object key as an S3 canonical path: each segment escaped exactly once. */
function encodeS3Path(key: string): string {
  return `/${key
    .split('/')
    .map((segment) =>
      encodeURIComponent(segment).replace(
        /[!'()*]/g,
        (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
      ),
    )
    .join('/')}`;
}

function unescapeXml(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function tagValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match ? unescapeXml(match[1]!) : undefined;
}

interface S3Object {
  key: string;
  size: number;
}

/** One page of ListObjectsV2, parsed from S3's XML response. */
async function listObjectsPage(
  fetchSigned: SignedFetch,
  bucket: string,
  prefix: string,
  continuationToken?: string,
): Promise<{ objects: S3Object[]; nextContinuationToken?: string }> {
  const query = new URLSearchParams({ 'list-type': '2', prefix });
  if (continuationToken) query.set('continuation-token', continuationToken);

  const response = await fetchSigned(`${s3Origin(bucket)}/?${query.toString()}`);
  if (!response.ok) {
    throw new Error(`S3 ListObjectsV2 failed: HTTP ${response.status} ${await response.text()}`);
  }
  const xml = await response.text();

  const objects: S3Object[] = [];
  for (const [, block] of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
    const key = tagValue(block, 'Key');
    if (key === undefined) continue;
    objects.push({ key, size: Number(tagValue(block, 'Size') ?? '0') });
  }

  const truncated = tagValue(xml, 'IsTruncated') === 'true';
  const next = tagValue(xml, 'NextContinuationToken');
  return { objects, ...(truncated && next ? { nextContinuationToken: next } : {}) };
}

/** Download one object to a local path. */
async function downloadObject(
  fetchSigned: SignedFetch,
  bucket: string,
  key: string,
  dest: string,
): Promise<void> {
  const response = await fetchSigned(`${s3Origin(bucket)}${encodeS3Path(key)}`);
  if (!response.ok) {
    throw new Error(`S3 GetObject ${key} failed: HTTP ${response.status} ${await response.text()}`);
  }
  await fs.writeFile(dest, Buffer.from(await response.arrayBuffer()));
}

/** Download an s3:// skill prefix and return the local directory. */
async function fetchS3Skill(source: string, fetchSigned: SignedFetch): Promise<string> {
  const uri = source.endsWith('/') ? source : `${source}/`;
  const sourceHash = stableHash(uri);
  const typeDir = path.join(SKILLS_BASE, 's3');

  const cached = await resolveCached(typeDir, sourceHash);
  if (cached) return cached;

  const withoutScheme = uri.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);
  if (!bucket) throw new Error(`Invalid S3 URI (no bucket): ${uri}`);

  const tempDir = path.join(typeDir, sourceHash);
  await cleanup(tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  const tempRoot = await fs.realpath(tempDir);

  let total = 0;
  let continuationToken: string | undefined;
  do {
    const page = await listObjectsPage(fetchSigned, bucket, prefix, continuationToken);
    for (const object of page.objects) {
      total += object.size;
      if (total > S3_MAX_SIZE_BYTES) {
        await cleanup(tempDir);
        throw new Error(`S3 skill ${uri} exceeds 1 GB size limit`);
      }
      const rel = object.key.slice(prefix.length).replace(/^\/+/, '');
      if (!rel) continue;

      // Resolve against the realpath'd root, not tempDir: on macOS os.tmpdir()
      // is itself a symlink (/var -> /private/var), so comparing an unresolved
      // dest against a resolved root flags every legitimate key as traversal.
      const dest = path.resolve(tempRoot, rel);
      if (dest !== tempRoot && !dest.startsWith(tempRoot + path.sep)) {
        await cleanup(tempDir);
        throw new Error(`Path traversal detected in S3 key: ${object.key}`);
      }
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await downloadObject(fetchSigned, bucket, object.key, dest);
    }
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);

  if (total === 0) {
    await cleanup(tempDir);
    throw new Error(`No files found at S3 URI: ${uri}`);
  }

  return renameAndCacheSkill(typeDir, tempDir, sourceHash, uri);
}

/**
 * Resolve s3:// skill URIs to local filesystem paths.
 *
 * Any fetch failure raises and fails the invocation — a partial skill set would
 * silently run the agent without capabilities the harness declared.
 */
export async function resolveS3Skills(sources: string[], fetchSigned?: SignedFetch): Promise<string[]> {
  const s3 = fetchSigned ?? s3Client();
  const paths: string[] = [];
  for (const uri of sources) {
    try {
      paths.push(await fetchS3Skill(uri, s3));
    } catch (error) {
      throw new Error(`Failed to resolve S3 skill '${uri}': ${String(error)}`);
    }
  }
  return paths;
}

/**
 * Fetch each S3 skill's SKILL.md and concatenate its body for a system prompt.
 *
 * Fails loudly (real exception, real stack) rather than silently running
 * without the instructions the agent depends on.
 *
 * `placeholders`, if given, maps NAME -> value substituted for every literal
 * "{{NAME}}" found in the fetched skill text -- e.g. { SPACE_ID: "123" }
 * replaces every "{{SPACE_ID}}". This is how skill content stays deployment-
 * agnostic: a skill never hardcodes a space id, it writes "{{SPACE_ID}}" and
 * whichever deployment loads it fills in its own resolved value. Only put
 * non-secret values here -- this text becomes part of the system prompt, so
 * anything substituted in is visible to the model. Never pass a credential
 * (e.g. the Storyblok PAT) through this; secrets stay server-side in tool
 * implementations, never in prompt text.
 */
export async function loadSkillInstructions(
  uris: string[],
  options: { fetchSigned?: SignedFetch; placeholders?: Record<string, string> } = {},
): Promise<string> {
  const sections: string[] = [];
  for (const localDir of await resolveS3Skills(uris, options.fetchSigned)) {
    const content = await fs.readFile(path.join(localDir, 'SKILL.md'), 'utf8');
    // strip the YAML frontmatter, keep the markdown body
    const body = content.startsWith('---') ? content.split('---').slice(2).join('---') : content;
    sections.push(body.trim());
  }
  let text = sections.join('\n\n---\n\n');
  for (const [name, value] of Object.entries(options.placeholders ?? {})) {
    text = text.split(`{{${name}}}`).join(value);
  }
  return text;
}
