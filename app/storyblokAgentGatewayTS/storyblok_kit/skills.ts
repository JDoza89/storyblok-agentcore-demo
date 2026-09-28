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
 */
export async function syncSkillsRoot(
  s3Uri: string,
  options: { fetchSigned?: SignedFetch } = {},
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

  let written = 0;
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
    written++;
  }

  if (written === 0) {
    await cleanup(root);
    throw new Error(`No files found at S3 URI: ${uri}`);
  }

  await fs.writeFile(path.join(root, '.synced'), new Date().toISOString());
  return root;
}
