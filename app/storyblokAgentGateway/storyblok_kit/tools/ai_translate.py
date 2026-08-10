import logging
import time

import httpx
from strands import tool

from storyblok_kit.credentials import resolve_storyblok_pat, resolve_storyblok_space_id

logger = logging.getLogger(__name__)

MANAGEMENT_API_BASE = "https://api-us.storyblok.com/v1"
POLL_INTERVAL_SECONDS = 2.0
MAX_POLL_SECONDS = 120.0


@tool
def ai_translate_story(story_id: int, lang: str, overwrite: bool = True, code: str | None = None) -> str:
    """Translate a story into a target language using Storyblok's AI-translate endpoint, and wait for it to finish.

    Storyblok processes this as a background job: triggering it returns a
    background_task_id, not the translated content. This tool polls that job's
    progress and only returns once it has genuinely reached 100% (confirmed
    complete) -- Storyblok's backend saves the translated fields directly onto
    the story itself at that point, as `<field>__i18n__<lang>` keys alongside
    the default-language values. No follow-up updateStory call is needed.

    This calls Storyblok's raw Management API directly with a resolved PAT,
    independent of whatever MCP transport (direct connection or Gateway) the
    calling agent otherwise uses for its other Storyblok tool calls.

    After this tool returns successfully, re-fetch the story yourself (a plain
    getStory, no `language` query param -- it doesn't reliably surface these
    fields) and look for `__i18n__<lang>` suffixed keys to confirm the actual
    translated text before reporting the locale as done.

    Args:
        story_id: The numeric id of the story to translate.
        lang: Official language code, e.g. "de", "ja".
        overwrite: Whether to replace any existing translated values for this language.
        code: Custom language identifier from Space Settings, only if this space uses
            a custom locale code different from the official language code.
    """
    token = resolve_storyblok_pat()
    if not token:
        return "Could not resolve the Storyblok credential -- cannot call ai_translate."

    space_id = resolve_storyblok_space_id()
    if space_id is None:
        return "Could not resolve the Storyblok space id -- cannot call ai_translate."

    headers = {"Authorization": token, "Content-Type": "application/json"}
    body = {"lang": lang, "overwrite": overwrite}
    if code:
        body["code"] = code

    try:
        trigger_response = httpx.put(
            f"{MANAGEMENT_API_BASE}/spaces/{space_id}/stories/{story_id}/ai_translate",
            headers=headers,
            json=body,
            timeout=30.0,
        )
        trigger_response.raise_for_status()
    except httpx.HTTPError as error:
        logger.warning("ai_translate trigger failed: %s", error)
        return f"ai_translate trigger failed: {error}"

    task_id = trigger_response.json().get("background_task_id")
    if not task_id:
        return f"ai_translate did not return a background_task_id: {trigger_response.text}"

    task_url = f"{MANAGEMENT_API_BASE}/spaces/{space_id}/background_tasks/{task_id}"
    deadline = time.monotonic() + MAX_POLL_SECONDS
    saw_progress = 0

    while time.monotonic() < deadline:
        time.sleep(POLL_INTERVAL_SECONDS)
        try:
            poll_response = httpx.get(task_url, headers=headers, timeout=10.0)
        except httpx.HTTPError as error:
            logger.warning("ai_translate poll request failed: %s", error)
            continue

        if poll_response.status_code == 404:
            if saw_progress >= 100:
                return (
                    f"Translation to '{lang}' completed for story {story_id}. "
                    "Re-fetch the story and check for __i18n__ fields to confirm."
                )
            return (
                f"The translation job for story {story_id} disappeared before reaching 100% "
                f"(last seen progress: {saw_progress}%). This usually means it did not "
                "complete -- do not assume the story was translated. Re-fetch the story to check "
                "for __i18n__ fields before reporting this locale as done either way."
            )

        task = poll_response.json().get("background_task", {})
        saw_progress = task.get("progress", saw_progress)
        if saw_progress >= 100:
            return (
                f"Translation to '{lang}' completed for story {story_id}. "
                "Re-fetch the story and check for __i18n__ fields to confirm."
            )

    return (
        f"Timed out after {MAX_POLL_SECONDS:.0f}s waiting for the translation job on story "
        f"{story_id} to reach 100% (last seen progress: {saw_progress}%). Do not assume it "
        "completed -- re-fetch the story to check for __i18n__ fields before reporting this "
        "locale as done either way."
    )
