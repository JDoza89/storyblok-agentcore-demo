# storyblokAgentGateway

A Strands-based agent on Amazon Bedrock AgentCore that turns a product-launch brief into a Storyblok landing page.
It never publishes directly — every page lands in a **Reviewing** workflow stage for human approval.

This is the Gateway-connected variant: it reaches Storyblok's MCP server through an AgentCore Gateway target
(IAM-signed, policy-enforceable) instead of a bare API key.

## Related repos

- **Frontend**: [re-invent-demo](https://github.com/JDoza89/re-invent-demo) on AWS Amplify — renders whatever this
  agent writes to Storyblok, whether it's still in Reviewing or already published.

## What the agent does

Full workflow lives in `skills/productBrief-to-storyblokPage/SKILL.md`:

1. **Parse the brief** — product, launch date, audience, benefits, markets, assets. Flags missing fields instead
   of inventing them.
2. **Gather what it needs** — live `productPage` component whitelist, whether a page already exists, brand
   guidelines, real assets.
3. **Write the page** — `createStory`, or a diffed `updateStory` for an existing one, using only whitelisted
   components.
4. **Localize** — Storyblok's AI-translate job per market, confirmed complete before moving on.
5. **Generate metadata** — alt text, SEO title/description per locale.
6. **Move to review** — `createWorkflowStageChange` into Reviewing.
7. **Stop** — summarizes what changed, which locales completed, and any gaps, for the human reviewer.

## The human review loop

The agent's credential has no publish rights — enforced, not just instructed. Once a story is in Reviewing:

1. A human reviews it in Storyblok's Visual Editor (or the [frontend](https://github.com/JDoza89/re-invent-demo)).
2. They edit directly if anything needs a human touch.
3. Only a human publishes. Reviewing is not live no matter what the agent does next.

## Governance: the `productPage` content type

Pages are always the `productPage` content type, not the generic `page` type. Its `body` field has
`restrict_components: true` and an explicit whitelist — Storyblok's API rejects anything outside it.

That whitelist is also where non-engineering governance happens: whoever owns the content model adds or removes
allowed components directly in Storyblok, no code change needed. The agent fetches it fresh every run (step 2
above), so a content-model change takes effect on the next invocation.

## Architecture

- **Runtime**: AgentCore Runtime, a Strands `Agent` behind `BedrockAgentCoreApp`. Model is native Bedrock Claude
  (`storyblok_kit/model.py`) — the execution role's own IAM credentials authenticate the call, no separate API key.
- **Storyblok access**: an AgentCore Gateway target proxies MCP calls to Storyblok's hosted MCP server, signed
  with AWS_IAM/SigV4, with AgentCore's Cedar policy engine attached for tool-call authorization.
- **AI tools** (`ai_translate_story`, `fetch_ai_branding_guidelines`): local Strands `@tool` functions in
  `storyblok_kit/tools/`, calling Storyblok's Management API directly since neither has an MCP equivalent — see
  "Local tools and the Gateway MCPClient" below.
- **Credentials**: the Storyblok PAT and space id are `ApiKeyCredentialProvider`s in AgentCore Identity, never
  hardcoded. `storyblok_kit/credentials.py` resolves them per-request. Pointing a new deployment at a different
  space/PAT needs zero code changes — just its own credential providers under the same names.
- **Guardrail**: `storyblok_kit/hooks/space_guard.py` blocks any tool call whose `space_id` doesn't match — a
  code-level restriction, not just a prompt instruction.
- **Instructions**: workflow logic lives in two S3-hosted Skills, fetched per request and folded into the system
  prompt with `{{SPACE_ID}}` filled in — see `skills/` below.
- **Infra**: provisioned via the `agentcore` CLI and its generated CDK stack (`agentcore/cdk/`) — one
  `agentcore deploy` for the runtime, Gateway, policy engine, and credential providers.

## Local tools and the Gateway MCPClient

`ai_translate_story` and `fetch_ai_branding_guidelines` call Storyblok's Management API directly, as local Strands
`@tool` functions sitting alongside the Gateway `MCPClient` in `_build_tools()` — neither has a Storyblok MCP
equivalent.

This combination was once believed to break tool discovery outright. It didn't — two unrelated, since-fixed bugs
were the real cause:

- **Redundant tool-name prefix.** `MCPClient(..., prefix="reinventdemogateway")` stacked on the Gateway's own
  `{target}___{tool}` naming produced unwieldy names (`reinventdemogateway_SBMCP___execute_mutating`), which made
  the model narrate fake results instead of actually calling tools. Fixed by dropping the `prefix` kwarg.
- **Wrong IAM resource ARN.** The Gateway role's policy scoped `GetResourceApiKey` to a workload identity named
  after the *target* (`SBMCP`) instead of the *gateway's own id* — the one AWS actually checks. Every tool call
  failed with a generic error until this was fixed (see step 4).

Local tools and the Gateway `MCPClient` coexist fine now — confirmed by retest.

For the full build walkthrough, including the real AWS-side issues hit along the way and what the underlying
harness (Strands + AgentCore) gives you for free versus what had to be hand-built, see `TUTORIAL.md` at the
project root.

## Reusability

- `storyblok_kit/` holds tools (`tools/ai_translate.py`, `tools/ai_branding.py`) for capabilities the Storyblok
  MCP lacks. Structured so it _could_ become its own reusable package of Storyblok-agent building blocks
  (credential resolution, the space-id guardrail, a skill fetcher, these tools).
- `skills/` in this repo is **not** what the deployed agent reads from — the real source of truth is the S3 bucket
  in `main.py`'s `SKILL_S3_URIS`. Edit here for visibility/version control, then push to S3 for it to take effect.

## Environment Variables

| Variable                                    | Required              | Description                                                           |
| -------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| `LOCAL_DEV`                                  | No                    | Set to `1` to use `.env.local` instead of AgentCore Identity          |
| `AGENTCORE_CREDENTIAL_STORYBLOK_SPACE_ID`    | Local dev only        | Overrides the `storyblok-space-id` credential provider for local runs |
| `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL`  | Yes (injected by CDK) | The Gateway's MCP endpoint                                            |
| `AWS_REGION`                                 | Yes                   | Region for AgentCore Identity/Bedrock calls                           |

When deployed, the space id and PAT resolve from AgentCore Identity's credential providers (`storyblok-space-id`,
`storyblok-mcp-pat`) — see `storyblok_kit/credentials.py`. Nothing in this repo should ever contain an actual PAT
or space id; treat one as a bug and rotate the credential if you find it.

## Layout

Application code lives at the agent root. `agentcore/` holds the configuration and state that `deploy`, `dev`,
and `invoke` all rely on.

### Input Validation

Validate invocation input before forwarding it to Strands. Keep plain prompts typed as strings. If the app accepts
caller-supplied message history, retain `strip_trailing_tool_use()`, which normalizes the history tail first.

## Developing locally

Install the tools, create a Gateway, connect it to Storyblok, lock down its permissions, then run it.

### 1. Install the tools

```bash
npm install -g @aws/agentcore          # built against 0.26.0
cd agentcore/cdk && npm install        # what `agentcore deploy` runs under the hood
```

Also needs AWS credentials configured (`aws configure` / SSO) and Python 3.14 + [`uv`](https://github.com/astral-sh/uv).

### 2. Create the Gateway

```bash
agentcore add gateway --name reInventDemoGateway --authorizer-type AWS_IAM
```

The agent calls this Gateway instead of Storyblok directly, so permissions are controlled in one place. Works
fine through the CLI as-is.

### 3. Connect the Gateway to Storyblok

`agentcore add gateway-target` is broken for this combination (MCP-server target + API-key auth) — it leaves a
broken, half-created entry in `agentcore.json`'s `unassignedTargets`. Workaround: create the target directly, then
import it.

```bash
# Store the Storyblok token and space id as credentials AgentCore manages -- never hardcoded here.
agentcore add credential --name storyblok-mcp-pat --type api-key --api-key <your-storyblok-pat>
agentcore add credential --name storyblok-space-id --type api-key --api-key <your-storyblok-space-id>

# Create the target directly, bypassing the broken CLI command
aws bedrock-agentcore-control create-gateway-target \
  --gateway-identifier <your-gateway-id> \
  --name SBMCP \
  --target-configuration '{"mcp":{"mcpServer":{"endpoint":"https://mcp.labs.storyblok.com/mcp"}}}' \
  --credential-provider-configurations '[{
    "credentialProviderType": "API_KEY",
    "credentialProvider": {
      "apiKeyCredentialProvider": {
        "providerArn": "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default/apikeycredentialprovider/storyblok-mcp-pat",
        "credentialParameterName": "Authorization",
        "credentialPrefix": "Bearer ",
        "credentialLocation": "HEADER"
      }
    }
  }]' \
  --region us-east-1

# Bring it under agentcore's tracking
agentcore import gateway --arn arn:aws:bedrock-agentcore:<region>:<account-id>:gateway/<your-gateway-id>
```

Delete any stale `unassignedTargets` entry a failed attempt left behind.

Storyblok's MCP server is session-stateful — without passing the session header through, every call after the
first fails with "Server not initialized":

```bash
aws bedrock-agentcore-control update-gateway-target \
  --gateway-identifier <your-gateway-id> --target-id <your-target-id> \
  --metadata-configuration '{"allowedRequestHeaders":["Mcp-Session-Id"],"allowedResponseHeaders":["Mcp-Session-Id"]}' \
  --region us-east-1
```

### 4. Let the Gateway read the credentials

The Gateway's IAM role (separate from the agent's own) can't read the credential store by default — fails on the
first tool call with a generic "An internal error occurred" ([turn on debug mode](#5-run-it-locally) to see the
real error underneath).

Set that role's `storyblok-gateway-credential-access` policy to this in full, filling in your own region/account id:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AgentCoreGatewayApiKeyTokenVaultDefault",
      "Effect": "Allow",
      "Action": "bedrock-agentcore:GetResourceApiKey",
      "Resource": [
        "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default",
        "arn:aws:bedrock-agentcore:<region>:<account-id>:workload-identity-directory/default",
        "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default/apikeycredentialprovider/storyblok-mcp-pat",
        "arn:aws:bedrock-agentcore:<region>:<account-id>:workload-identity-directory/default/workload-identity/<your-gateway-id>"
      ]
    },
    {
      "Sid": "AgentCoreGatewayApiKeyTokenVaultPerKey",
      "Effect": "Allow",
      "Action": "bedrock-agentcore:GetResourceApiKey",
      "Resource": "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default/apikeycredentialprovider/storyblok-mcp-pat"
    },
    {
      "Sid": "AgentCoreGatewaySecrets",
      "Effect": "Allow",
      "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:<region>:<account-id>:secret:bedrock-agentcore-identity!default/apikey/storyblok-mcp-pat-*"
    },
    {
      "Sid": "AgentCoreGatewayWorkloadIdentity",
      "Effect": "Allow",
      "Action": [
        "bedrock-agentcore:GetWorkloadAccessToken",
        "bedrock-agentcore:GetWorkloadAccessTokenForUserId",
        "bedrock-agentcore:CompleteResourceTokenAuth"
      ],
      "Resource": "*"
    }
  ]
}
```

**Critical:** that last `workload-identity/<your-gateway-id>` resource must be the gateway's own id (e.g.
`reinventdemo-reinventdemogateway-ianze4pdtu`), **not** the target's name (e.g. `SBMCP`) — an easy mistake that
produces the exact same generic error as a missing policy, and only debug mode (step 5) will reveal it.

### 5. Run it locally

```bash
agentcore dev
```

Starts a local server on `0.0.0.0:8080`, running inside this app's `.venv` already.

```bash
agentcore invoke --dev "What can you do"
```

If any Gateway call fails with a generic "An internal error occurred. Please retry later.", turn on
[debug mode](https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-debug-messages.html) to see the
real error underneath:

```bash
aws bedrock-agentcore-control update-gateway --gateway-identifier <your-gateway-id> \
  --name <your-gateway-name> --role-arn <your-gateway-role-arn> --authorizer-type AWS_IAM \
  --protocol-configuration '{"mcp":{"supportedVersions":["2025-03-26","2025-06-18","2025-11-25"]}}' \
  --exception-level DEBUG
```

Turn it back off (omit `--exception-level`) once you're done — a real error message is exactly what you don't
want a production caller to see.

## Deployment

`agentcore deploy` deploys the project into Amazon Bedrock AgentCore. `agentcore invoke` invokes it.
