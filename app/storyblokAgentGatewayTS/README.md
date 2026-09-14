# storyblokAgentGatewayTS

TypeScript port of `app/storyblokAgentGateway/` (Python/Strands). Same agent,
same behavior, same AgentCore Gateway — it points at the existing
`reInventDemoGateway` and the same Storyblok space.

## Layout

| TypeScript | Python equivalent | Purpose |
| --- | --- | --- |
| `main.ts` | `main.py` | Entrypoint: system prompt, per-session agent cache, payload extraction, SSE streaming |
| `model/load.ts` | `storyblok_kit/model.py` | Bedrock Claude client |
| `mcp_client/client.ts` | `mcp_client/client.py` | Gateway MCP client over SigV4 |
| `storyblok_kit/sigv4.ts` | (`mcp-proxy-for-aws` + boto3) | Shared request signer |
| `storyblok_kit/credentials.ts` | `storyblok_kit/credentials.py` | PAT via AgentCore Identity; space id / region from env |
| `storyblok_kit/skills.ts` | `storyblok_kit/skills.py` | S3 skill fetch, cache, `{{SPACE_ID}}` substitution |
| `storyblok_kit/hooks/space-guard.ts` | `storyblok_kit/hooks/space_guard.py` | Blocks tool calls targeting another space |
| `storyblok_kit/tools/ai-branding.ts` | `storyblok_kit/tools/ai_branding.py` | `fetch_ai_branding_guidelines` |
| `storyblok_kit/tools/ai-translate.ts` | `storyblok_kit/tools/ai_translate.py` | `ai_translate_story` |

## Two places this necessarily diverges from the Python agent

Both are environment constraints, not design choices:

1. **SigV4 is hand-rolled** (`storyblok_kit/sigv4.ts`). Python gets Gateway
   signing from `mcp-proxy-for-aws` and S3 from boto3. Neither has a TypeScript
   equivalent here, so one signer backs both the Gateway transport and S3.
2. **S3 uses signed REST, not `@aws-sdk/client-s3`.** The AgentCore Node
   packager marks that package esbuild-external and does *not* copy it into the
   deployment zip, so importing it yields a bundle that throws
   `MODULE_NOT_FOUND` on the first invocation. Verified by unpacking the zip.

## Environment variables

| Variable | Set by | Notes |
| --- | --- | --- |
| `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL` | CDK, automatic | All gateways wire to all runtimes |
| `STORYBLOK_SPACE_ID` | `agentcore.json` envVars | Required — the agent refuses to build a prompt without it |
| `STORYBLOK_REGION` | `agentcore.json` envVars | Defaults to `us` |
| `AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT` | local dev only | Deployed, the PAT resolves via AgentCore Identity |

## Deploying

`agentcore deploy` esbuild-bundles `main.ts` straight to `main.js` — the
`dist/` output from `npm run build` is for local testing only.

**One manual step after the first deploy.** The Python runtime's S3 access comes
from an inline policy (`storyblok-skills-s3-access`) attached to its execution
role out-of-band; it is not in the CDK stack, so a freshly created TS runtime
role will not have it and every invocation will fail to load skills. Attach the
same policy to the new role:

```sh
ROLE=$(aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id <ts-runtime-id> --region us-east-1 \
  --query roleArn --output text)

aws iam put-role-policy --role-name "$(basename "$ROLE")" \
  --policy-name storyblok-skills-s3-access \
  --policy-document '{"Version":"2012-10-17","Statement":[
    {"Sid":"ListSkillsBucket","Effect":"Allow","Action":"s3:ListBucket",
     "Resource":"arn:aws:s3:::storyblok-agentcore-skills-485530831632"},
    {"Sid":"ReadSkillsObjects","Effect":"Allow","Action":"s3:GetObject",
     "Resource":"arn:aws:s3:::storyblok-agentcore-skills-485530831632/*"}]}'
```

Moving this into `agentcore/cdk/lib/cdk-stack.ts` would remove the manual step
for both runtimes.

## Local development

```sh
npm install
npm run dev        # tsx watch main.ts
```

Requires `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL`, `STORYBLOK_SPACE_ID`, and
AWS credentials. The two Management API tools need a PAT, which locally means
`AGENTCORE_CREDENTIAL_STORYBLOK_MCP_PAT` — without it they return a "could not
resolve the Storyblok credential" message rather than throwing, exactly as the
Python agent does.
