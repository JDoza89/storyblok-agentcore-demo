import logging

from strands.hooks import BeforeToolCallEvent, HookProvider, HookRegistry

from storyblok_kit.credentials import resolve_storyblok_space_id

logger = logging.getLogger(__name__)


def _find_mismatched_space_id(value, allowed):
    """Recursively search a tool call's input for a space_id that isn't ours."""
    if isinstance(value, dict):
        for key, nested in value.items():
            if key == "space_id" and nested is not None and str(nested) != str(allowed):
                return nested
            found = _find_mismatched_space_id(nested, allowed)
            if found is not None:
                return found
    elif isinstance(value, list):
        for item in value:
            found = _find_mismatched_space_id(item, allowed)
            if found is not None:
                return found
    return None


class SpaceIdGuard(HookProvider):
    """Blocks any tool call that targets a Storyblok space other than the one this
    deployment is configured for.

    This is a real, code-level guardrail, not just a prompt instruction. The
    Storyblok credential these agents use is not scoped to a single space, so
    nothing at the API/IAM level stops a call from reaching a different space
    if the model ever specified one -- this hook is what actually enforces the
    single-space restriction.

    The allowed space id is resolved from AWS (resolve_storyblok_space_id, the
    same credential-provider mechanism as the PAT), not hardcoded, at hook
    construction time -- which happens per-session, during request handling,
    so AgentCore Identity's workload token is available. This is what makes
    the hook reusable across agents/deployments unchanged: point a different
    deployment's storyblok-space-id credential provider at a different space,
    and this hook enforces that one instead, with no code change.

    If the space id can't be resolved at all, every space-scoped tool call is
    blocked rather than let through -- fail closed, not fail open.

    Deliberately not gated on a tool-name prefix: different agents expose
    Storyblok tools through different MCP clients with different prefixes
    (e.g. "storyblok_" on a direct connection, "reinventdemogateway_" through
    a Gateway target) -- a prefix check tied to one agent's wiring would
    silently stop protecting the moment this hook is reused by another agent
    with a different MCP setup. Instead this scans every tool call's input,
    regardless of tool name, for a mismatched space_id -- strictly safer, and
    genuinely portable across any agent that adds this hook.
    """

    def __init__(self) -> None:
        self.allowed_space_id = resolve_storyblok_space_id()
        if self.allowed_space_id is None:
            logger.error(
                "Could not resolve the allowed Storyblok space id -- every "
                "space-scoped tool call will be blocked until this is fixed."
            )

    def register_hooks(self, registry: HookRegistry, **kwargs) -> None:
        registry.add_callback(BeforeToolCallEvent, self._check)

    def _check(self, event: BeforeToolCallEvent) -> None:
        tool_name = event.tool_use.get("name", "")
        bad_space_id = _find_mismatched_space_id(event.tool_use.get("input"), self.allowed_space_id)
        if bad_space_id is not None:
            logger.warning(
                "Blocked tool call %s: space_id %s does not match the allowed space %s",
                tool_name, bad_space_id, self.allowed_space_id,
            )
            event.cancel_tool = (
                f"Blocked: this agent may only operate on space_id {self.allowed_space_id}. "
                f"The tool call specified space_id {bad_space_id}, which is not allowed."
            )
