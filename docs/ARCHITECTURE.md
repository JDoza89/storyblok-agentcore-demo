# reInventDemo Agent Architecture

A product-launch brief goes in. A Storyblok landing page comes out: built from the space's approved components, localized into the brief's target markets, carrying alt text and SEO metadata, and parked in the **Reviewing** workflow stage for a human to publish. This document covers how that works, how the agent harness around the model is built, and why each piece ended up the way it did.

## What the project does

reInventDemo is an Amazon Bedrock AgentCore project. One agent runtime turns a free-form product brief into a `productPage` story in a single Storyblok space. The agent never publishes. It has no publish rights, and every layer described below assumes it shouldn't try to work around that.

The request path looks like this:

```text
caller (agentcore invoke, FlowMotion HTTP node)
  │  SigV4
  ▼
AgentCore Runtime: storyblokAgentGatewayTS (Strands TypeScript agent, Bedrock Claude)
  │                                   │
  │  MCP over SigV4                   │  Management API with PAT
  │  (model + harness reads)          │  (AI branding, AI translate only)
  ▼                                   ▼
reInventDemoGateway ── Cedar ──▶ SBMCP target ──▶ Storyblok MCP server
                                                   │
S3 skills bucket (read at session start)           ▼
Secrets Manager (PAT)                         Storyblok space
```

The pieces:

| Piece | What it is | Why it's there |
| --- | --- | --- |
| `storyblokAgentGatewayTS` | AgentCore runtime, CodeZip, Node 22, Strands TypeScript SDK | Runs the agent loop. A port of an earlier Python agent, which was dropped once the TypeScript version reached parity. |
| `reInventDemoGateway` | AgentCore Gateway with the Storyblok MCP server as target `SBMCP` | Gives the agent Storyblok's MCP tools as `SBMCP___search`, `SBMCP___describe`, `SBMCP___execute_readonly`, and `SBMCP___execute_mutating`, behind IAM auth and a policy engine. |
| `reInventDemoPolicyEngine` | Cedar policies in `ENFORCE` mode | Allows discovery tools unconditionally, allows exactly 13 named Storyblok operations, and forbids `execute_destructive` outright. |
| Skills bucket | `s3://storyblok-agentcore-skills-485530831632` | Holds the agent's instructions as Agent Skills, so an instruction change is an upload, not a redeploy. |
| Storyblok PAT | Secrets Manager secret behind the `storyblok-mcp-pat` credential | Used only for AI branding and AI translate, the two Storyblok calls the MCP server doesn't expose. |
| `ai_translate_story`, AI branding fetch | `storyblok_kit/tools/ai-translate.ts`, `storyblok_kit/ai-branding.ts` | Cover what the MCP server doesn't: waiting for an AI-translate background job, and reading the space's AI Branding settings. v1 exposed the branding fetch as a tool; v2 calls it from the harness at session start. |

💡 The allowlist lives in two places. `agentcore/policies/*.cedar` holds the readable source, but the deploy reads the inline copy in `agentcore/agentcore.json`, with `sourceFile` acting only as a pointer. Edit both, then read the live policy back after deploying.

## What "harness" means here

The model decides what to do next. The harness is everything around that decision: the instructions it reads, the tools it can call, the guardrails that stop a bad call, how context is built and kept, what shape the output has to take, and what checks the result afterward.

A useful way to read any harness is to ask, for each rule the agent must follow, where the rule is enforced. A rule can live in prose (the model has to remember it), in a tool (the model can't get it wrong because the tool does it), in a hook (the call is blocked before it happens), in policy (the Gateway denies it), or in a verifier (the result is checked after the fact). The further a rule sits from prose, the less it depends on the model's attention at step 40 of a long run.

## The v1 harness, layer by layer

v1 is `app/storyblokAgentGatewayTS/`. It's a working agent and it stays in the tree unchanged.

### Instructions

The system prompt in `main.ts` is short: who the agent is, how Gateway tool names map to the names skills use, which skill to start with, and the `AGENT_RESULT` contract. Everything else lives in skills.

Skills load through Strands' `AgentSkills` plugin. The plugin injects each skill's name and description before an invocation, and the agent pulls a skill's full text on demand. Switching to it cut the base prompt from 17,948 to 1,508 characters, and a skill costs nothing until the agent uses it. `read_skill_resource` exists because `AgentSkills` lists a skill's `references/` files but gives the agent no way to open them.

`syncSkillsRoot` mirrors the whole bucket at session start, so installing a skill is an upload. The local cache is keyed on the bucket's listing (every key, ETag, and size), not on the S3 URI. Keying on the URI made the cache permanently stale: a warm container never looked at the bucket again, so an edited skill changed nothing until the container was replaced.

The skills themselves are instruction-only. An earlier version baked in a snapshot of the content model, which went stale and told the agent a testimonial component didn't exist on product pages when it did. Now every structural fact (component whitelist, field schemas, folders, workflow stages) is discovered live on each run. `{{SPACE_ID}}` and `{{REGION}}` placeholders are substituted into the mirrored `.md` files, so skill text stays deployment-agnostic.

### Tools

The Gateway MCP client is built per session, inside real request handling. Constructing it at module load time, before any request context existed, left its discovered tools disconnected from what the model saw.

It carries no client-side `prefix`. The Gateway already names tools `{target}___{tool}`, and stacking a prefix on top produced names the model avoided calling.

`ai_translate_story` triggers Storyblok's AI-translate job and waits for it. Two lessons are built into it:

- **It queues jobs per story.** Two translations running against the same story race, and one locale silently ends up empty. On one run, `de` and `ja` were triggered together, `ja` landed 29 translated values and `de` landed zero. The tool serializes calls instead of relying on the model to remember to wait.
- **It trusts the story, not the task record.** The background task is deleted when it ends, so a 404 means either "finished" or "died". The tool counts `__i18n__<lang>` keys on the story before and after, and reports what it found.

### Guardrails

`SpaceIdGuard` is a `BeforeToolCall` hook that scans every tool call's input, regardless of tool name, for a `space_id` that isn't the configured one. The PAT isn't scoped to one space, so nothing at the API level stops a call to another space. If the allowed space ID can't be resolved, every space-scoped call is blocked: fail closed, not open. It isn't gated on a tool-name prefix, because prefixes differ between a direct MCP connection and a Gateway target, and a prefix check would silently stop protecting when the wiring changed.

Cedar sits behind the hook. `allowScopedOperations` permits `execute_readonly` and `execute_mutating` only when `context.input.operation` is one of 11 named operations. `denyExecuteDestructive` is a backstop `forbid` that wins over any `permit`.

### Context and sessions

The runtime keeps one `Agent` per session ID in a `Map` capped at 128 entries, used as an LRU so one process can't leak history between sessions or grow without limit. History is in-process and resets on a cold start.

Before streaming a turn, the handler snapshots the agent's messages. If the stream fails, it restores the snapshot. Without that, the failed user turn stays in the cached agent and the next turn sends two user messages in a row, which Anthropic models reject.

`NullConversationManager` means nothing is trimmed. For a single long run, that keeps the field map the agent built in step 2 of the skill from being dropped halfway through.

### Credentials and transport

Two constraints from the environment shaped this layer:

1. **SigV4 is hand-rolled** in `storyblok_kit/sigv4.ts`. The AgentCore Node packager marks `@aws-sdk/client-s3` as esbuild-external and doesn't copy it into the deployment zip, so importing it throws `MODULE_NOT_FOUND` on the first invocation. One signer backs the Gateway transport, S3, and Secrets Manager.
2. **The PAT comes straight from Secrets Manager.** The documented path, `withApiKey()` falling back to the request's workload access token, can't work here. AgentCore only supplies that token from an inbound header, and SigV4 invocation doesn't send one. Minting one is refused. So the execution role reads the secret directly, and `resolveCredential` keeps AgentCore Identity as a fallback.

The PAT is also primed before the handler's first `yield`. The request context lives in `AsyncLocalStorage`, and it doesn't survive an async-generator suspension, so tools running mid-stream couldn't resolve it themselves.

Space ID and region are plain environment variables. They aren't secrets, so running them through AgentCore Identity only added a round trip.

### Output contract

The run ends with one line the caller parses:

```text
AGENT_RESULT: {"status":"created","storyId":"123","storyUrl":"https://app.storyblok.com/#!/me/spaces/<space>/stories/0/0/123","locales":{"de":"complete"},"notes":"one short sentence"}
```

In v1, the model writes that line. The prompt spends several paragraphs on its rules: one line, valid JSON, no code fence, nothing after it, locales reported from a re-fetch rather than a tool's claim.

## Why v2 exists

Ask "where is this rule enforced?" of the v1 skill and the answer is almost always "in prose". Most of `productBrief-to-storyblokPage/SKILL.md` is invariants the model has to remember, and several exist because of a real incident:

- **Never publish, always end in `Reviewing`.** A run once matched the target stage on meaning and picked "Ready to Publish". That stage has `allow_admin_publish: true`, and the page went live without a human seeing it.
- **`updateStory` must send the full content.** It replaces `story.content` whole. A localization step once sent `{"component": "page"}` with no `body`, and the page lost its body.
- **Story references hold UUIDs, never numeric IDs.** A run linked related products by ID. Storyblok resolves references by UUID, so the field looked populated in the API and rendered empty on the frontend.
- **SEO fields are required, in every locale.** A run shipped `meta_title` and `meta_description` as empty strings.
- **A 200 isn't proof.** Re-fetch after every write and check the result.

Each of these is a rule the model has to hold in mind through a long run, and each fix so far was more prose. Cedar doesn't cover them either: it checks the operation name, so a `publish: true` parameter on an allowed `updateStory` passes policy.

Meanwhile, the two parts of v1 that had moved into code, `SpaceIdGuard` and the translate queue, are the two that stopped failing. v2 applies that lesson to the rest.

## The v2 harness

v2 replaced v1 in place. The code lives in `app/storyblokAgentGatewayTS/` and the skills in `skills/`, the same paths v1 used, and the production `storyblokAgentGatewayTS` runtime runs it. The runtime's `name` never changed, so its CloudFormation logical ID never changed either: each deploy swapped the code bundle in place, and the runtime ID and ARN the Slack app invokes stayed the same. v1 lives on in git history at commit `8399452`.

The model, the Gateway, Cedar, the credential path, `SpaceIdGuard`, the translate tool, and the session LRU all carry over from v1. What changes is where the launch rules live.

### Space context, read by code

`storyblok_kit/space-context.ts` reads the space at session start, in parallel with the skill sync. Every read except branding goes through the same Gateway MCP target the model uses: `storyblok_kit/storyblok-reads.ts` opens its own MCP connection and calls `SBMCP___execute_readonly` from code, so Cedar authorizes each read and the results never enter the model's conversation. It reads:

- every component reachable from `productPage`'s whitelists, including nested `bloks` whitelists
- the workflow stages
- the folders
- the AI Branding settings
- the enabled languages

It renders all of it into a **Space context** section of the system prompt: one line per field with its type, whitelist, translatable and required flags, and description. Story-reference fields are marked `story uuids[]` or `one story uuid`, with their folder and content type.

The v1 skill's "no snapshot" principle holds, because nothing here is checked into the repo and a schema edit in Storyblok shows up on the next session. What changes is who does the reading. In v1, the model spent its first dozen or so tool calls on this discovery, one search → describe → execute round at a time, and every result stayed in context for the rest of the run.

The review stage is resolved by exact name, `Reviewing`, and rejected if either `allow_publish` or `allow_admin_publish` is true. This space's "Ready to Publish" stage has `allow_admin_publish: true`, which is how the v1 incident happened. If no usable `Reviewing` stage exists, the harness picks the closest non-publishing stage and adds a warning the model has to repeat in its summary.

Schema and stages are required. If either read fails, the session fails, because the hooks can't guard writes without them. Branding, folders, and languages are best-effort and surface as warnings.

The same `SpaceContext` object feeds the hooks and the verifier, so the model and the guards work from one reading of the schema. Because branding is already in the prompt, v2 no longer registers `fetch_ai_branding_guidelines` as a tool.

### Launch invariants, enforced in hooks

`storyblok_kit/hooks/launch-invariants.ts` is a Strands plugin that runs on every Storyblok `execute_*` call. Before the call, it:

- fills in `space_id` when the model leaves it out (`SpaceIdGuard` still rejects a different one)
- blocks any call with a truthy `publish` flag anywhere in its parameters (publish *operations* never get this far: none is on Cedar's allowlist)
- allows `createWorkflowStageChange` only when `workflow_stage_id` is the review stage's ID
- leaves out any block that isn't on its field's `component_whitelist`, read from the live schema: the page body, nested `bloks` fields (a `cards` block only takes `card`), and blocks embedded in richtext fields, each against its own field's list. The write still goes ahead without them. Once it succeeds, the readback tells the model what was left out, and each removed block becomes a gap comment pinned to the field it would have gone in. On an update, blocks already on the story are never removed, so a block someone added by hand stays. A field with no whitelist stays unrestricted, as it is in Storyblok
- rejects any story-reference value that isn't a UUID, walking the whole content tree so nested references (`productVariant.colorway`, `testimonial.customer`) are checked too
- requires `content.component` to be `productPage` on `createStory`
- on `updateStory`, reads the story fresh and blocks the write if `content.component` changes, `body` shrinks, or a top-level field that held a value would disappear
- blocks `createDiscussion*` and `createComment*`, pointing the model at `flag_gap` (see below)

A blocked call comes back to the model as `Blocked by the harness:` plus the reason and what to change, so the model fixes and retries instead of stalling.

v2 guards the existing `updateStory` instead of adding a patch tool. The skills and the MCP references already describe `updateStory`, and a guard keeps that tool surface the same while closing the lost-body failure. It does mean an update can't remove blocks. If the brief asks for that, the model leaves them and says so, and a human removes them in the Visual Editor.

After a successful `createStory`, `updateStory`, or `createWorkflowStageChange`, the hook reads the story back and appends one line to the tool result:

```text
[harness readback of story 123, uuid …] body: 7 block(s) | stage: Reviewing ✓ | published: no | SEO missing: meta_title[de] | de: 29 translated field(s) | references: all uuids.
```

The model learns what actually landed without pulling the whole story back into context. The hook also records the write in a `RunTracker` (story ID, create or update, staged stories, and the locales passed to `ai_translate_story`).

`storyblok_kit/story-checks.ts` holds the checks as pure functions. The hook, the readback, and the verifier all call the same ones, so a write the hook let through and a story the verifier passes are judged by the same rules.

### Verification after the loop

When the agent's turn ends, `storyblok_kit/verifier.ts` reads the story back and checks it:

| Check | Critical |
| --- | --- |
| Story can be read back | ✅ |
| Not published | ✅ |
| `body` present and non-empty | ✅ |
| `content.component` is `productPage` | ✅ |
| In the review stage | ✅ |
| Story references are UUIDs | ❌ |
| SEO fields set, default language and each translated locale | ❌ |
| Each translated locale has `__i18n__` fields and complete SEO | ❌ |

If anything fails, the harness sends the agent one follow-up turn listing exactly what failed and streams that turn to the caller too. It caps at one repair turn: that's enough for a missed SEO field or a forgotten stage change, and a run still failing after a targeted repair needs a human, not a third attempt.

### The output contract, written by the harness

The model no longer writes `AGENT_RESULT`. It ends with a `NOTES:` line, and the harness builds the result line from the tracker and the verifier, in the same shape v1's callers already parse:

- `status` is `unchanged` if nothing was written, `failed` if a critical check still fails, and otherwise `created` or `updated` from the tracker
- `locales` comes from the verifier: `complete`, `partial` (translated but SEO incomplete), or `missing`
- `notes` is the model's `NOTES:` sentence, plus "Harness flagged: …" for any check still failing

### Gaps become comments on the story

Every gap the run flags (a brief that left something out, an unresolved related product, an empty spec table, a locale that isn't enabled) ends up as a discussion on the story, so the reviewer finds it in the Visual Editor next to the content it's about, not only in the Slack summary.

The model records gaps with a local `flag_gap` tool as it finds them, optionally passing the block's `_uid`, component, and field so the comment is pinned there. Nothing is posted during the run. After verification and any repair turn, `storyblok_kit/story-comments.ts` posts each recorded gap once through the Gateway (`createDiscussionForStory`, on Cedar's allowlist), followed by any verification check still failing and the session's space warnings. Posting at the end means a gap the agent resolved later in the run never becomes a stale comment. Storyblok requires a `block_uid` on every discussion, so a story-level gap, or one naming a block the story doesn't have, attaches to the story's root block (`content._uid`) with the block and field it was about kept in the message. A posting failure never fails the run, and each failure is logged with its gap's message; `notes` in `AGENT_RESULT` says how many gaps were posted.

The model can't post discussions itself: the launch-invariant hook blocks `createDiscussion*` and `createComment*` and points it at `flag_gap`, so each gap is posted exactly once.

### Skills, trimmed to judgment

`skills/productBrief-to-storyblokPage/SKILL.md` drops from 219 lines to 121. Gone: the discovery steps, the Reviewing-stage section, the publish rules, the destructive-overwrite procedure, the UUID shape-check ritual, and the re-fetch-to-confirm instructions. Code owns all of those now.

What stays is the part code can't do: reading the brief, matching it to components by purpose, shaping each field type (richtext, assets, tables, references, `__i18n__` values), matching related products by name, and writing in the brand's voice rather than the brief's. The skill opens with a short "what the harness owns, and what you own" section, so the model knows a blocked call is expected feedback. `skills/brand-guidelines/SKILL.md` now reads the guidelines from the Space context instead of calling a tool, and keeps v1's no-fallback rule.

### A regression check from the same code

`scripts/verify-story.ts` runs the runtime's verifier from a laptop:

```bash
npx tsx scripts/verify-story.ts <storyId> --locales de,ja
npx tsx scripts/verify-story.ts --context
```

Run the agent on a brief, then point the script at the story it built. It prints `PASS`/`FAIL` per check and exits non-zero on any failure, so a prompt or skill change gets a pass/fail signal. `--context` prints the Space context the system prompt would carry this session.

## v1 vs v2

| Rule or job | v1 | v2 |
| --- | --- | --- |
| Discover schema, stages, folders, branding | Model, through MCP, every run | Code, at session start |
| Never publish | Skill prose, Cedar operation allowlist | Hook blocks publish operations and flags, Cedar still behind it |
| End in `Reviewing` | Skill prose | Hook allows only the review stage ID, verifier checks it |
| Full-content `updateStory` | Skill prose, re-fetch ritual | Hook compares against a fresh read and blocks shrinking updates |
| UUIDs in reference fields | Skill prose, shape check before writes | Hook rejects non-UUIDs from the live schema, verifier re-checks |
| SEO in every locale | Skill prose, re-fetch | Readback after writes, verifier, one repair turn |
| Confirm a write landed | Model re-fetches the story | Harness appends a readback |
| `AGENT_RESULT` line | Written by the model | Built by the harness from verified state |
| Main skill | 219 lines | 121 lines |

## Tradeoffs and limitations

- **Cedar can't check parameters, so the hooks stay.** Moving the space-ID, publish-flag, and review-stage rules into Cedar `forbid` policies was tested against the live Gateway. The Gateway exposes top-level tool arguments like `operation` to Cedar, but not the nested `parameters` object: the space and publish rules never fired (a wrong space ID and `publish: true` both reached Storyblok), and the stage rule denied every stage change, including the one to `Reviewing`. The policies were rolled back within minutes. `SpaceIdGuard` and the `LaunchInvariants` parameter checks are the only enforcement for these rules, and Cedar stays the operation allowlist.
- **Two calls still skip MCP.** AI branding and AI translate aren't exposed by the Storyblok MCP server, so they call the Management API directly with the PAT, and Cedar never sees them. Everything else, including every harness read (space context, the pre-update read, readbacks, and the verifier), goes through the Gateway. The harness reads use operations already on Cedar's readonly allowlist, plus `getSpace` for the enabled languages.
- **The prompt is bigger.** The field map and the branding JSON add tokens to every turn in exchange for fewer tool calls. The net effect on tokens and latency hasn't been measured yet.
- **One repair turn.** A run that fails verification twice ends with the failures in `notes` instead of retrying.
- **Locales are inferred.** The verifier checks the locales the agent passed to `ai_translate_story`. If the agent never translates a locale the brief asked for, the verifier doesn't know it was asked for. The model's summary is still where that gap shows up.
- **Shape, not quality.** Verification confirms that fields are set and well-formed. It doesn't judge whether the copy follows the brand voice.
- **The context is per session.** It's read once when a session starts. A long-lived session keeps its first reading even if the schema changes mid-session.
- **Story IDs come from tool results.** The tracker parses the new story's ID out of the `createStory` result. If that response shape changes and parsing fails, the run reports `unchanged` even though a story exists.

## Running, deploying, and reverting

Skills are served from the root of `s3://storyblok-agentcore-skills-485530831632`. The runtime syncs the whole bucket, which also carries skills that aren't in this repo (`storyblok-use-mcp`, `storyblok-use-storyblok`, `storyblok-model-content`), so upload changed skills file by file and never run `sync --delete` at the root:

```bash
aws s3 cp skills/productBrief-to-storyblokPage/SKILL.md s3://storyblok-agentcore-skills-485530831632/productBrief-to-storyblokPage/SKILL.md
```

A skill upload takes effect on the next session, with no redeploy. Code and config changes deploy with:

```bash
agentcore validate
agentcore deploy
```

`agentcore/cdk/lib/cdk-stack.ts` grants the runtime's role `s3:ListBucket` and `s3:GetObject` on the skills bucket, so the access lives in the stack instead of only in the inline policy that used to be attached by hand. The PAT needs no extra grant, because the L3 construct already grants `GetSecretValue` on the identity secrets.

🛑 Keep the runtime's `name` as `storyblokAgentGatewayTS`. Renaming it destroys the runtime and creates a new one with a new ID, which breaks the Slack app. Everything else (code, `codeLocation`, env vars) updates in place.

Run the example brief, then verify the story it built:

```bash
agentcore invoke --runtime storyblokAgentGatewayTS --prompt-file example-product-brief.md
cd app/storyblokAgentGatewayTS
npx tsx scripts/verify-story.ts <storyId> --locales de,ja
```

For local development, run `npm run dev` in `app/storyblokAgentGatewayTS/`. The verify script needs `STORYBLOK_SPACE_ID`, `STORYBLOK_REGION`, and a PAT, either through `AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT` or through `STORYBLOK_PAT_SECRET_ID` with AWS credentials that can read that secret.

To go back to v1, restore its code and skills from git, upload the two restored skill files to the bucket root, and deploy. The runtime keeps its ID:

```bash
git checkout 8399452 -- app/storyblokAgentGatewayTS skills
agentcore deploy
```

## What's been verified so far

Local checks against the live space:

- The Space context renders from the real schema, stages, folders, and branding.
- The verifier passes on an existing story, Aurora Summit 1: 7 blocks, in `Reviewing`, SEO set, and 30 translated fields each for `de` and `ja`.
- The hook blocks a `publish` flag, a `publishStory` operation, the "Ready to Publish" stage ID, an update that drops `body`, an update that shrinks `body`, and a numeric ID in `relatedProducts.products`.
- The hook allows a stage change to `Reviewing` and a full-content update, and fills in `space_id`.

On the deployed runtime, a connectivity prompt (not a brief) starts a session end to end: the PAT resolves, the Space context loads, the skills sync from S3, and the harness writes `AGENT_RESULT` with `status: "unchanged"`. A full brief hasn't run through the deployed v2 yet, so there are no end-to-end numbers.

## What's next?

- **Measure it.** Run the same briefs through v2 and through v1 (restored from `8399452` locally) and compare tool-call counts, tokens, wall-clock time, and `verify-story.ts` results.
- **Turn the verifier into an online eval.** The checks already produce pass/fail per run. Wiring them into an AgentCore evaluator would score every production run, not only the ones someone checks by hand.
- **Add a sliding-window conversation manager.** With discovery and re-fetches out of the transcript, a sliding window is less likely to drop something the run still needs.
- **Retire the out-of-band S3 policy.** The runtime's role still carries the hand-attached `storyblok-skills-s3-access` inline policy. The CDK grant now covers the same access, so the inline policy can be deleted.
