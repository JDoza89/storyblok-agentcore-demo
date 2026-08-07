# storyblokAgentGateway

A Strands-based agent, deployed on Amazon Bedrock AgentCore, that turns a free-text product-launch brief into a
Storyblok landing page. It never publishes directly — every page it touches lands in a **Reviewing** workflow
stage for a human to approve.

This is the Gateway-connected variant: it reaches Storyblok's MCP server through an AgentCore Gateway target
(IAM-signed, policy-enforceable) rather than connecting to it directly with a bare API key.

## Related repos

- **Frontend**: [re-invent-demo](https://github.com/JDoza89/re-invent-demo) — deployed on AWS Amplify. Renders
  whatever this agent writes to Storyblok. Use it to see what a page actually looks like once the agent has drafted
  it, either while it's still sitting in Reviewing (via Storyblok's Visual Editor preview) or after a human
  publishes it.

## What the agent does

Given a product brief pasted into the prompt, it runs through a fixed workflow, described in full in
`skills/productBrief-to-storyblokPage/SKILL.md`:

1. **Parse the brief** — product name, launch date, target audience, benefits, target markets/locales, referenced
   assets. Flags anything missing rather than inventing content to fill the gap.
2. **Gather what it needs, in one read-only pass** — the live `productPage` component whitelist (never trusted
   from memory), whether this product already has a page (making this run an update instead of a create), the
   space's brand guidelines, and the real assets referenced in the brief (found via Storyblok's asset folders, not
   guessed).
3. **Write the page** — `createStory` for a new product, or a diffed `updateStory` for one that already exists,
   using only components from the live whitelist.
4. **Localize** — triggers Storyblok's AI-translate job per target market and confirms it actually completed
   before moving on.
5. **Generate metadata** — alt text per image, SEO title/description per locale.
6. **Move to review** — `createWorkflowStageChange` into the Reviewing stage.
7. **Stop** — summarizes what was built or changed, which locales completed, and any gaps, for the human who
   reviews next.

## The human review loop

The agent's Storyblok credential has no publish rights, and nothing in this codebase ever calls a publish
operation — that's enforced by what the agent is allowed to do, not just by instruction. Once a story lands in
Reviewing:

1. A human opens the story in Storyblok's Visual Editor (or previews it on the [frontend](https://github.com/JDoza89/re-invent-demo)) and reviews what the agent drafted.
2. They edit directly in the Visual Editor if anything needs a human touch — copy, image choices, spec data the
   agent flagged as missing.
3. Only a human moves the story out of Reviewing and publishes it. The workflow stage is the actual gate: a story
   sitting in Reviewing is not live no matter what the agent does next.

## Governance: the `productPage` content type

Pages this agent creates or updates are always a dedicated `productPage` content type, not the generic `page`
type used elsewhere in the space. `productPage`'s `body` field is configured in Storyblok with
`restrict_components: true` and an explicit `component_whitelist` — Storyblok's Management API rejects any
component outside that list, so this isn't a convention the agent has to police itself.

That whitelist is also where non-engineering governance actually happens: whoever owns the Storyblok content model
can add or remove allowed components (say, approve a new `testimonial` block for product pages) directly in
Storyblok's schema, with no code or prompt change on the agent's side. The agent fetches this whitelist fresh at
the start of every run rather than trusting a copy from a previous run — see step 2 above — so a content-model
change takes effect on the very next invocation.

## Architecture

- **Runtime**: Amazon Bedrock AgentCore Runtime, a Strands `Agent` behind `BedrockAgentCoreApp`'s
  `@app.entrypoint`. Model is native Bedrock Claude (`storyblok_kit/model.py`) — the execution role's own IAM
  credentials authenticate the model call, no separate API key.
- **Storyblok access**: an AgentCore Gateway target proxies MCP calls to Storyblok's hosted MCP server
  (`mcp.labs.storyblok.com`), authenticated with AWS_IAM/SigV4 rather than a bare token, with AgentCore's Cedar
  policy engine attached for tool-call authorization.
- **Credentials**: the Storyblok PAT and the single Storyblok space id this agent is allowed to touch are both
  registered as `ApiKeyCredentialProvider`s in AgentCore Identity (`storyblok-mcp-pat`, `storyblok-space-id`) —
  never hardcoded. `storyblok_kit/credentials.py` resolves them per-request (an env var override for local dev,
  a workload-identity-token exchange when deployed). Pointing a different deployment at a different space or PAT
  needs zero code changes, just its own credential providers under those same names.
- **Guardrail**: `storyblok_kit/hooks/space_guard.py` registers a Strands `BeforeToolCallEvent` hook that blocks
  any tool call whose `space_id` doesn't match the resolved value above — a real, code-level restriction, not just
  a prompt instruction, which matters because the Storyblok credential itself isn't scoped to one space.
- **Instructions**: the actual workflow logic lives in two S3-hosted Skills (`SKILL.md` files), fetched at request
  time and folded into the system prompt, with a `{{SPACE_ID}}` placeholder filled in from the resolved credential
  above — see `skills/` below.
- **Infra**: provisioned via the `agentcore` CLI and its generated CDK stack (`agentcore/cdk/`) — the runtime, its
  execution role, the Gateway, the policy engine, and the credential providers all come from one `agentcore deploy`.

For the full build walkthrough, including the real AWS-side issues hit along the way (a Gateway bug, IAM
permission gaps, PAT-scoping limitations, a Bedrock quota wall) and what the underlying harness (Strands +
AgentCore) gives you for free versus what had to be hand-built, see `TUTORIAL.md` at the project root.

## Reusability

- `storyblok_kit/` has tools that the Storyblok MCP is currently lacking. It is structured so that it
  _could_ become its own repo of reusable Storyblok-agent building blocks (credential resolution, the space-id
  guardrail, a skill fetcher) that any Strands agent adds as a dependency, rather than living inside this one app.
- `skills/` in this repo is **not** what the deployed agent actually reads from — the real source of truth is the
  S3 bucket referenced in `main.py`'s `SKILL_S3_URIS`. This folder exists purely so the instruction content is
  visible and version-controlled in git; if you edit a skill, push the change to S3 (and clear the local skill
  cache) for it to actually take effect. Think of it as a mirror for review, not a live config.

## Environment Variables

variable/provider **names**:

| Variable                                    | Required              | Description                                                           |
| ------------------------------------------- | --------------------- | --------------------------------------------------------------------- |
| `LOCAL_DEV`                                 | No                    | Set to `1` to use `.env.local` instead of AgentCore Identity          |
| `AGENTCORE_CREDENTIAL_STORYBLOK_SPACE_ID`   | Local dev only        | Overrides the `storyblok-space-id` credential provider for local runs |
| `AGENTCORE_GATEWAY_REINVENTDEMOGATEWAY_URL` | Yes (injected by CDK) | The Gateway's MCP endpoint                                            |
| `AWS_REGION`                                | Yes                   | Region for AgentCore Identity/Bedrock calls                           |

When deployed, the space id and the Storyblok PAT are resolved from AgentCore Identity's credential providers
(`storyblok-space-id`, `storyblok-mcp-pat`) — see `storyblok_kit/credentials.py`. Nothing in this repo should ever
contain an actual PAT value or space id credential; if you find one, treat it as a bug and rotate the credential.

## Layout

The generated application code lives at the agent root directory. At the root, there is a `.gitignore` file, an
`agentcore/` folder which represents the configurations and state associated with this project. Other `agentcore`
commands like `deploy`, `dev`, and `invoke` rely on the configuration stored here.

### Input Validation

Validate invocation input before forwarding it to Strands. Keep plain prompts typed as strings. If the app accepts a
caller-supplied message history, retain `strip_trailing_tool_use()`, which normalizes the history tail before
invoking the agent.

## Developing locally

### 1. Install the CLI and the CDK project's dependencies

```bash
npm install -g @aws/agentcore          # the agentcore CLI (this project was built against 0.26.0)
cd agentcore/cdk && npm install        # pulls in @aws/agentcore-cdk, aws-cdk-lib, constructs -- what `agentcore deploy` actually runs
```

You'll also need AWS credentials configured (`aws configure` / SSO) with permissions for Bedrock AgentCore, and
Python 3.14 + [`uv`](https://github.com/astral-sh/uv) for the agent app itself.

### 2. Create the Gateway

From the project root:

```bash
agentcore add gateway --name reInventDemoGateway --authorizer-type AWS_IAM
```

This part works fine through the CLI.

### 3. Create the Gateway target -- via the AWS CLI, not `agentcore add gateway-target`

`agentcore add gateway-target --type mcp-server --outbound-auth api-key ...` does not complete correctly for this
target type/auth combination. It leaves behind a broken, "unassigned" entry in `agentcore.json` -- a placeholder
tool definition and `outboundAuth: {"type": "NONE"}` instead of the real API-key config, never actually attached to
the gateway. If you look in `agentcore.json` and see an `unassignedTargets` entry that looks like that, this is why.

The workaround is to create the target directly against the AgentCore control plane, then have `agentcore` import
the result rather than create it:

```bash
# 1. Create both credential providers (if you haven't already) -- the PAT the target
#    uses as outbound auth to Storyblok, and the space id storyblok_kit/credentials.py
#    and SpaceIdGuard resolve at runtime. Both are real AWS-managed credentials, never
#    hardcoded anywhere in this repo.
agentcore add credential --name storyblok-mcp-pat --type api-key --api-key <your-storyblok-pat>
agentcore add credential --name storyblok-space-id --type api-key --api-key <your-storyblok-space-id>

# 2. Create the actual gateway target with the real AWS CLI, bypassing `agentcore add gateway-target`
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

# 3. Bring it under agentcore's own tracking so agentcore.json/CDK know it exists
agentcore import gateway --arn arn:aws:bedrock-agentcore:<region>:<account-id>:gateway/<your-gateway-id>
```

Then delete the stale `unassignedTargets` entry from `agentcore.json` if the earlier failed attempt left one there.

Storyblok's MCP server is session-stateful, so also make sure the target's `metadataConfiguration` passes through
the session header, or every `tools/call` after the first will fail with "Server not initialized":

```bash
aws bedrock-agentcore-control update-gateway-target \
  --gateway-identifier <your-gateway-id> --target-id <your-target-id> \
  --metadata-configuration '{"allowedRequestHeaders":["Mcp-Session-Id"],"allowedResponseHeaders":["Mcp-Session-Id"]}' \
  --region us-east-1
```

### 4. Update your Gateway IAM role's permission policy

Creating the Gateway in step 2 auto-creates its own IAM role -- a separate role from the agent runtime's execution
role. By default it has no permission to read anything from the token vault, which fails silently as a generic
error at `tools/call` time with no useful message (this was the root cause behind the Gateway invocation bug
encountered while building this).

Find that role's `storyblok-gateway-credential-access` inline policy (or create one with this name if it doesn't
exist yet) and add this to its `Resource` list, replacing `<region>`/`<account-id>` with your own:

```json
"Resource": [
    "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default",
    "arn:aws:bedrock-agentcore:<region>:<account-id>:workload-identity-directory/default",
    "arn:aws:bedrock-agentcore:<region>:<account-id>:token-vault/default/apikeycredentialprovider/storyblok-mcp-pat",
    "arn:aws:bedrock-agentcore:<region>:<account-id>:workload-identity-directory/default/workload-identity/<gateway>"
]
```

`SBMCP` in the last entry is the target's own name (from step 3 above) -- Gateway resolves a workload identity
scoped to that name when fetching the target's credential, so this has to match whatever you named your target.

### 5. Run it locally

`agentcore dev` will start a local server on 0.0.0.0:8080 -- it runs against this app's `.venv` directly, so you
don't need to `source .venv/bin/activate` first. Activating it yourself is only useful if you want to run Python
directly (`python main.py`) or point editor tooling at the right interpreter.

In a new terminal, you can invoke that server with:

`agentcore invoke --dev "What can you do"`

## Deployment

After providing credentials, `agentcore deploy` will deploy your project into Amazon Bedrock AgentCore.

Use `agentcore invoke` to invoke your deployed agent.
