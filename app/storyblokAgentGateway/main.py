from typing import Any
from collections import OrderedDict
from strands import Agent
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from storyblok_kit.model import load_model
from storyblok_kit.skills import load_skill_instructions
from storyblok_kit.credentials import resolve_storyblok_space_id
from storyblok_kit.hooks.space_guard import SpaceIdGuard
from mcp_client.client import get_all_gateway_mcp_clients

app = BedrockAgentCoreApp()
log = app.logger

SKILL_S3_URIS = [
    "s3://storyblok-agentcore-skills-485530831632/productBrief-to-storyblokPage",
    "s3://storyblok-agentcore-skills-485530831632/brand-guidelines",
]


def _build_system_prompt() -> str:
    """Build this session's system prompt, with skill placeholders filled in.

    Called per-session (from get_or_create_agent), not at module import time:
    filling in {{SPACE_ID}} needs resolve_storyblok_space_id(), which needs
    the per-request workload access token, only present during request
    handling -- the same reason _build_tools() below is deferred.

    Skill text never hardcodes a space id; it writes "{{SPACE_ID}}" and this
    is the one place that gets filled in, from the one resolved value, so a
    different deployment (different space, different PAT) needs no skill or
    code changes, just its own storyblok-space-id / storyblok-mcp-pat
    credential providers.
    """
    space_id = resolve_storyblok_space_id()
    if space_id is None:
        raise RuntimeError("Could not resolve the Storyblok space id -- refusing to build a system prompt without it.")

    return f"""
You are the Storyblok product-launch agent (Gateway-connected variant --
reaches Storyblok's MCP server through an AgentCore Gateway target rather
than connecting to it directly). You turn a product-launch brief into a
Storyblok landing page: assembling approved components, localizing into
target markets per brand guidelines, generating alt text and SEO metadata,
and moving the result into the pre-publish review workflow stage. You never
attempt to publish directly — you do not have publish rights, and should not
try to work around that.

Always invoke tools through the actual tool-calling mechanism available to you.
Never write a tool's arguments as plain JSON text in your response instead of
calling it — if you notice yourself about to do that, stop and make the real
tool call. A run that ends by printing JSON instead of calling a tool is a
failed run, not a completed one.

Follow the instructions below exactly.

{load_skill_instructions(SKILL_S3_URIS, placeholders={"SPACE_ID": str(space_id)})}
"""


def _build_tools() -> list:
    """Assemble this session's tools, including MCP clients.

    Called per-session (from get_or_create_agent), not at module import time --
    constructing the Gateway MCPClient at module load time (before any request/
    event-loop context exists) left its discovered tools disconnected from what
    the model actually saw. Building it per-session, inside real request
    handling, avoids that.

    Deliberately MCP-clients-only, no local (non-MCP) @tool functions mixed
    in. Confirmed reproducible 3/3 with Cedar policies correctly in place
    (ruling out an earlier, separate policy-wipe incident as the cause): any
    local @tool sharing this Agent's tools list with the Gateway MCPClient
    breaks discovery of the MCPClient's own tools. Traced through the Strands
    SDK source (strands/tools/mcp/mcp_client.py, strands/tools/registry.py) --
    MCPClient correctly implements ToolProvider, isn't misrouted by
    isinstance checks, and calling its load_tools() directly in isolation
    still returns the right tool set when nothing else shares the tools list.
    ai_translate_story and fetch_ai_branding_guidelines are still needed for
    the skill to fully work -- the real fix is exposing them as additional
    Gateway targets (e.g. lambda-function-arn) so they're discovered through
    this same MCPClient instead of as local tools, not adding them back here.
    """
    tools = []
    for mcp_client in get_all_gateway_mcp_clients():
        if mcp_client:
            tools.append(mcp_client)
    return tools


def _make_conversation_manager():
    return NullConversationManager()

# Reuses one Agent per session_id so each session keeps its own in-process
# conversation history (best-effort; resets on cold start). The cache is bounded
# to 128 sessions with LRU eviction (least-recently-used is dropped and its
# history reset) so a single process serving many sessions cannot leak history
# between them or grow without limit. For durable history, attach a session manager.
def agent_factory():
    cache = OrderedDict()
    def get_or_create_agent(session_id):
        if session_id in cache:
            cache.move_to_end(session_id)
            return cache[session_id]
        if len(cache) >= 128:
            cache.popitem(last=False)
        cache[session_id] = Agent(
            model=load_model(),
            system_prompt=_build_system_prompt(),
            tools=_build_tools(),
            conversation_manager=_make_conversation_manager(),
            hooks=[
                SpaceIdGuard(),
            ],
        )
        return cache[session_id]
    return get_or_create_agent
get_or_create_agent = agent_factory()


def strip_trailing_tool_use(messages: Any) -> list[dict]:
    """Strip toolUse blocks from the tail until the last message has none."""
    if not isinstance(messages, list):
        raise ValueError("messages must be a list")

    messages = list(messages)
    while messages:
        last = messages[-1]
        if not isinstance(last, dict):
            raise ValueError("each message must be an object")
        original_content = last.get("content", [])
        if not isinstance(original_content, list) or not all(isinstance(block, dict) for block in original_content):
            raise ValueError("each message content value must be a list of content blocks")

        content = [block for block in original_content if "toolUse" not in block]
        if len(content) == len(original_content):
            break
        if content:
            messages[-1] = {**last, "content": content}
            break
        messages.pop()

    return messages


def _extract_prompt(payload: dict):
    """Accept validated harness messages, tool results, or a plain prompt string."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    if "messages" in payload:
        return strip_trailing_tool_use(payload["messages"])
    if "tool_results" in payload:
        tool_results = payload["tool_results"]
        if not isinstance(tool_results, list) or not all(
            isinstance(tool_result, dict) and isinstance(tool_result.get("toolUseId"), str)
            for tool_result in tool_results
        ):
            raise ValueError("tool_results must contain objects with a toolUseId string")
        return [{"role": "user", "content": [{"toolResult": {
            "toolUseId": tr["toolUseId"],
            "status": tr.get("status", "success"),
            "content": tr.get("content", []),
        }} for tr in tool_results]}]
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        raise ValueError("prompt must be a string")
    return prompt


@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")


    session_id = getattr(context, 'session_id', 'default-session')
    agent = get_or_create_agent(session_id)

    prompt = _extract_prompt(payload)


    async for event in agent.stream_async(
        prompt,
    ):
        if not isinstance(event, dict) or "event" not in event:
            continue
        cbs = event["event"].get("contentBlockStart")
        if cbs is not None and not cbs.get("start"):
            continue
        yield event


if __name__ == "__main__":
    app.run()
