/**
 * Paste-a-brief form for non-technical users.
 *
 * One Lambda behind one Function URL does both jobs: `GET /` serves the page,
 * `POST /run` invokes the agent runtime and streams its output straight back to
 * the browser. No API Gateway, no static bucket, no second service to keep in
 * sync -- the whole thing is one URL you can paste into Slack.
 *
 * Streaming rather than fire-and-forget is deliberate. A run takes ~10 minutes,
 * and a form that sits silent that long looks broken; piping the agent's own
 * text deltas through gives the marketer something to watch. It also means the
 * browser holds the connection, so Lambda's 15-minute ceiling is the real
 * timeout -- see README for what happens when a run outlives it.
 */

import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const RUNTIME_ARN = process.env.AGENT_RUNTIME_ARN;
const PASSCODE = process.env.BRIEF_FORM_PASSCODE;
const REGION = process.env.AWS_REGION ?? 'us-east-1';

const client = new BedrockAgentCoreClient({ region: REGION });

/**
 * AgentCore requires a session id of 33-100 chars from [a-zA-Z0-9_-], and keys
 * its per-session agent cache on it. A fresh one per submission means two
 * marketers running briefs at the same time get independent agents rather than
 * one conversation with interleaved turns.
 */
function newSessionId() {
  return `brief-${randomUUID()}-${randomUUID()}`.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 100);
}

function respond(stream, status, contentType, body) {
  const out = awslambda.HttpResponseStream.from(stream, {
    statusCode: status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  });
  out.end(body);
}

export const handler = awslambda.streamifyResponse(async (event, responseStream) => {
  const method = event.requestContext?.http?.method ?? 'GET';
  const path = event.rawPath ?? '/';

  if (method === 'GET') {
    return respond(responseStream, 200, 'text/html; charset=utf-8', PAGE);
  }

  if (method !== 'POST' || !path.endsWith('/run')) {
    return respond(responseStream, 404, 'text/plain', 'Not found');
  }

  let body;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
    body = JSON.parse(raw ?? '{}');
  } catch {
    return respond(responseStream, 400, 'text/plain', 'Malformed request body.');
  }

  // Constant-ish check is not worth it here -- the passcode gates a demo tool,
  // and the Function URL is unlisted. It exists so a leaked URL alone does not
  // let anyone write to the production Storyblok space.
  if (!PASSCODE || body.passcode !== PASSCODE) {
    return respond(responseStream, 403, 'text/plain', 'Wrong passcode.');
  }

  const brief = typeof body.brief === 'string' ? body.brief.trim() : '';
  if (!brief) {
    return respond(responseStream, 400, 'text/plain', 'Paste a brief first.');
  }
  if (!RUNTIME_ARN) {
    return respond(responseStream, 500, 'text/plain', 'AGENT_RUNTIME_ARN is not configured.');
  }

  const stream = awslambda.HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });

  try {
    const result = await client.send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: RUNTIME_ARN,
        runtimeSessionId: newSessionId(),
        contentType: 'application/json',
        accept: 'text/event-stream',
        payload: new TextEncoder().encode(JSON.stringify({ prompt: brief })),
      }),
    );

    // The runtime yields SSE frames whose `data:` payload is a raw text delta
    // (main.ts `process()`), so unwrapping them here gives the browser plain
    // prose rather than protocol noise.
    let buffered = '';
    for await (const chunk of result.response) {
      buffered += new TextDecoder().decode(chunk, { stream: true });
      const frames = buffered.split('\n');
      buffered = frames.pop() ?? '';
      for (const line of frames) {
        if (line.startsWith('data:')) stream.write(line.slice(5).trimStart());
      }
    }
    stream.end();
  } catch (error) {
    // The stream is already open with a 200 by this point, so an error can only
    // be reported in-band. Say so plainly rather than closing silently and
    // leaving the page looking like it finished.
    stream.write(`\n\n--- The run stopped early: ${String(error?.message ?? error)}\n`);
    stream.write('Check Storyblok -- the story may exist and be in Reviewing already.\n');
    stream.end();
  }
});
