# storyblokAgentGatewayTS

The Storyblok product-launch agent: turns a product brief into a Storyblok
landing page through the `reInventDemoGateway`, and leaves it in the review
stage for a human. This is the code the `storyblokAgentGatewayTS` runtime runs,
which is the runtime the Slack app invokes. See `docs/ARCHITECTURE.md` for the
reasoning behind every design decision.

The launch rules (never publish, review stage only, uuids in reference fields,
no destructive updates) are enforced by the harness in code, not by skill
prose. The earlier prose-only version is in git history at `8399452`.

## Layout

| File | Purpose |
| --- | --- |
| `main.ts` | Entrypoint: system prompt, session cache, streaming, verify-and-repair loop, `AGENT_RESULT` |
| `model/load.ts` | Bedrock Claude client |
| `mcp_client/client.ts` | Gateway MCP client over SigV4 |
| `storyblok_kit/sigv4.ts` | Shared request signer for the Gateway, S3, and Secrets Manager |
| `storyblok_kit/credentials.ts` | PAT from Secrets Manager; space id and region from env |
| `storyblok_kit/skills.ts` | S3 skill sync and cache, keyed on the bucket's contents |
| `storyblok_kit/gateway.ts` | The harness's own Gateway MCP connection, shared by its reads and its one write |
| `storyblok_kit/storyblok-reads.ts` | The harness's reads (`execute_readonly` only) |
| `storyblok_kit/story-comments.ts` | Posts the run's gaps to the story as discussions, after verification |
| `storyblok_kit/ai-branding.ts` | AI branding rules, fetched directly (not exposed by the MCP server) |
| `storyblok_kit/space-context.ts` | Session-start read of schemas, review stage, folders, and branding, rendered into the prompt |
| `storyblok_kit/story-checks.ts` | Pure content checks shared by the hooks and the verifier |
| `storyblok_kit/hooks/space-guard.ts` | Blocks tool calls targeting another space |
| `storyblok_kit/hooks/launch-invariants.ts` | Blocks writes that break a launch rule; appends a readback after each write |
| `storyblok_kit/run-tracker.ts` | What this run actually did, recorded from tool results |
| `storyblok_kit/verifier.ts` | End-of-run checks and the repair prompt |
| `storyblok_kit/tools/ai-translate.ts` | `ai_translate_story`, queued per story |
| `storyblok_kit/tools/flag-gap.ts` | `flag_gap`, which records a gap (optionally pinned to a block and field) for the harness to post |
| `storyblok_kit/tools/skill-resources.ts` | `read_skill_resource`, for a skill's reference files |
| `scripts/verify-story.ts` | Run the verifier locally against any story |

## Two places this necessarily hand-rolls AWS calls

Both are environment constraints, not design choices:

1. **SigV4 is hand-rolled** (`storyblok_kit/sigv4.ts`). There's no TypeScript
   equivalent of `mcp-proxy-for-aws` for signing Gateway MCP requests, so one
   signer backs the Gateway transport, S3, and Secrets Manager.
2. **S3 uses signed REST, not `@aws-sdk/client-s3`.** The AgentCore Node
   packager marks that package esbuild-external and does *not* copy it into the
   deployment zip, so importing it yields a bundle that throws
   `MODULE_NOT_FOUND` on the first invocation. Verified by unpacking the zip.

## Environment variables

| Variable | Set by | Notes |
| --- | --- | --- |
| `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL` | CDK, automatic | All gateways wire to all runtimes |
| `STORYBLOK_SPACE_ID` | `agentcore.json` envVars | Required: the agent refuses to start a session without it |
| `STORYBLOK_REGION` | `agentcore.json` envVars | Defaults to `us` |
| `STORYBLOK_PAT_SECRET_ID` | `agentcore.json` envVars | The Secrets Manager secret holding the PAT |
| `AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT` | local dev only | Overrides the secret lookup |

## Skills

Skills live in `skills/` at the repo root and are served from the root of
`s3://storyblok-agentcore-skills-485530831632`. The runtime syncs the whole
bucket at session start, so the bucket also carries skills that aren't in this
repo (`storyblok-use-mcp`, `storyblok-use-storyblok`, `storyblok-model-content`).
Upload changed skills file by file, never with `sync --delete` at the root:

```bash
aws s3 cp skills/productBrief-to-storyblokPage/SKILL.md s3://storyblok-agentcore-skills-485530831632/productBrief-to-storyblokPage/SKILL.md
```

A skill upload takes effect on the next session with no redeploy.

## Deploying

```bash
agentcore validate
agentcore deploy
```

`agentcore deploy` esbuild-bundles `main.ts` straight to `main.js`; the `dist/`
output from `npm run build` is for local testing only. The runtime's S3 access
is granted in `agentcore/cdk/lib/cdk-stack.ts`, so there's no manual IAM step.

🛑 Keep the runtime's `name` in `agentcore.json` as `storyblokAgentGatewayTS`.
The name sets the CloudFormation logical ID: renaming it destroys the runtime
and creates a new one with a new id and ARN, which breaks the Slack app.
Changing `codeLocation`, env vars, or code updates it in place.

## Local development

```bash
npm install
npm run dev        # tsx watch main.ts
```

Requires `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL` (the gateway URL plus
`/mcp`), `STORYBLOK_SPACE_ID`, and AWS credentials allowed to invoke the Gateway.
The session's space context is read through the Gateway, so a session without
it fails at startup. A PAT is needed for the two direct calls (AI branding and
`ai_translate_story`); without one, branding falls back to the flagged
neutral-copy path and translation reports it can't run.

## Checking a run

```bash
npx tsx scripts/verify-story.ts <storyId> --locales de,ja
npx tsx scripts/verify-story.ts --context   # print this session's space context
```

Exits non-zero if any check fails, so it can gate a regression run. Needs the
same Gateway URL, `STORYBLOK_SPACE_ID`, and AWS credentials as local
development; `--context` also uses the PAT for AI branding.

## Reverting to the prose-only version

```bash
git checkout 8399452 -- app/storyblokAgentGatewayTS skills
```

Upload the restored `skills/` files to the bucket root the same way, then run
`agentcore deploy`. The runtime keeps its id.
