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
  etag: string;
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
    objects.push({
      key,
      size: Number(tagValue(block, 'Size') ?? '0'),
      etag: tagValue(block, 'ETag') ?? '',
    });
  }

  const truncated = tagValue(xml, 'IsTruncated') === 'true';
  const next = tagValue(xml, 'NextContinuationToken');
  return { objects, ...(truncated && next ? { nextContinuationToken: next } : {}) };
}

/**
 * List every object under a prefix, following continuation tokens.
 *
 * Both callers need the whole listing up front rather than page by page: the
 * listing is what the cache key is computed from, so it has to exist before
 * anything decides whether a download is needed.
 */
async function listAllObjects(
  fetchSigned: SignedFetch,
  bucket: string,
  prefix: string,
  label: string,
): Promise<S3Object[]> {
  const objects: S3Object[] = [];
  let total = 0;
  let continuationToken: string | undefined;
  do {
    const page = await listObjectsPage(fetchSigned, bucket, prefix, continuationToken);
    for (const object of page.objects) {
      total += object.size;
      if (total > S3_MAX_SIZE_BYTES) throw new Error(`${label} exceeds 1 GB size limit`);
      objects.push(object);
    }
    continuationToken = page.nextContinuationToken;
  } while (continuationToken);
  return objects;
}

/**
 * Cache key for a downloaded S3 prefix: the URI plus the current listing.
 *
 * Keying on the URI alone made the cache permanently stale -- a warm container
 * that had already downloaded a prefix never looked at the bucket again, so
 * re-uploading a skill changed nothing until the container was replaced.
 * Folding each object's key, etag and size in means an upload produces a new
 * key and the next session downloads it, while an unchanged bucket keeps
 * hitting the same cached directory.
 *
 * Sorted because ListObjectsV2 ordering is not part of its contract, and an
 * unstable key would defeat the cache entirely.
 */
function listingFingerprint(uri: string, objects: S3Object[]): string {
  const lines = objects.map((o) => `${o.key}:${o.etag}:${String(o.size)}`).sort();
  return stableHash([uri, ...lines].join('\n'));
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
  const typeDir = path.join(SKILLS_BASE, 's3');

  const withoutScheme = uri.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);
  if (!bucket) throw new Error(`Invalid S3 URI (no bucket): ${uri}`);

  // List before consulting the cache: the listing IS the cache key.
  const objects = await listAllObjects(fetchSigned, bucket, prefix, `S3 skill ${uri}`);
  if (objects.length === 0) throw new Error(`No files found at S3 URI: ${uri}`);

  const sourceHash = listingFingerprint(uri, objects);
  const cached = await resolveCached(typeDir, sourceHash);
  if (cached) return cached;

  const tempDir = path.join(typeDir, sourceHash);
  await cleanup(tempDir);
  await fs.mkdir(tempDir, { recursive: true });
  const tempRoot = await fs.realpath(tempDir);

  for (const object of objects) {
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

/**
 * Mirror an entire skills bucket/prefix to a local directory and return its path.
 *
 * `AgentSkills` accepts a parent directory containing skill subdirectories, so
 * one synced root gives the agent every skill in the bucket — including each
 * skill's `references/` files, which progressive disclosure depends on and
 * which a SKILL.md-only read would silently drop.
 *
 * This is what makes a skill installable without a redeploy: the bucket is
 * listed at runtime, so uploading a new skill directory is the whole install
 * step. Nothing here names an individual skill.
 *
 * Editing an existing skill works the same way, because the cache key is the
 * listing rather than the URI -- see `listingFingerprint`. The listing costs
 * one ListObjectsV2 per session; a bucket that hasn't changed re-uses the tree
 * already on disk and downloads nothing.
 *
 * Placeholders are substituted into every `.md` file after download, so skill
 * text stays deployment-agnostic (`{{SPACE_ID}}`, `{{REGION}}`) exactly as it
 * did when instructions were concatenated into the system prompt. Only
 * non-secret values belong here — this text reaches the model.
 */
export async function syncSkillsRoot(
  s3Uri: string,
  options: { fetchSigned?: SignedFetch; placeholders?: Record<string, string> } = {},
): Promise<string> {
  const fetchSigned = options.fetchSigned ?? s3Client();
  const uri = s3Uri.endsWith('/') ? s3Uri : `${s3Uri}/`;
  const withoutScheme = uri.slice('s3://'.length);
  const slash = withoutScheme.indexOf('/');
  const bucket = slash === -1 ? withoutScheme.replace(/\/$/, '') : withoutScheme.slice(0, slash);
  const prefix = slash === -1 ? '' : withoutScheme.slice(slash + 1);
  if (!bucket) throw new Error(`Invalid S3 URI (no bucket): ${s3Uri}`);

  // List before consulting the cache: the listing IS the cache key, so a
  // re-uploaded skill lands in a different root and gets downloaded, while an
  // unchanged bucket keeps hitting the one already on disk.
  const objects = await listAllObjects(fetchSigned, bucket, prefix, `Skills bucket ${uri}`);
  const root = path.join(SKILLS_BASE, 'root', listingFingerprint(uri, objects));

  // A completed sync leaves a marker; its absence means a previous run died
  // partway and the tree cannot be trusted.
  if (await exists(path.join(root, '.synced'))) return root;

  await cleanup(root);
  await fs.mkdir(root, { recursive: true });
  const realRoot = await fs.realpath(root);

  const written: string[] = [];
  for (const object of objects) {
    const rel = object.key.slice(prefix.length).replace(/^\/+/, '');
    if (!rel || rel.endsWith('/')) continue;

    const dest = path.resolve(realRoot, rel);
    if (!dest.startsWith(realRoot + path.sep)) {
      await cleanup(root);
      throw new Error(`Path traversal detected in S3 key: ${object.key}`);
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await downloadObject(fetchSigned, bucket, object.key, dest);
    written.push(dest);
  }

  if (written.length === 0) {
    await cleanup(root);
    throw new Error(`No files found at S3 URI: ${uri}`);
  }

  const placeholders = Object.entries(options.placeholders ?? {});
  if (placeholders.length > 0) {
    for (const file of written.filter((f) => f.endsWith('.md'))) {
      let text = await fs.readFile(file, 'utf8');
      for (const [name, value] of placeholders) text = text.split(`{{${name}}}`).join(value);
      await fs.writeFile(file, text);
    }
  }

  await fs.writeFile(path.join(root, '.synced'), new Date().toISOString());
  return root;
}
