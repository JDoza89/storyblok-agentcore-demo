---
name: brand-guidelines
description: Fetch and apply the current brand voice guidelines and localization approach from Storyblok before drafting, localizing, or tagging any content.
---

# Brand Guidelines

Before drafting, localizing into any market, or generating alt text/SEO metadata, retrieve the current brand guidelines. Space_id is **`{{SPACE_ID}}`**, region **`{{REGION}}`** — both fixed for this deployment, never ask for either, never guess a different value.

## Fetch them live, every run

**Call the `fetch_ai_branding_guidelines` tool.** It returns the space's real, live AI Branding settings. Whatever it returns is authoritative for this run.

Do this on every run. Never reuse guidelines you remember from a previous run, and never substitute your own assumptions about the brand's voice — the settings are edited in Storyblok by people who expect their edits to take effect immediately.

The tool returns whatever fields the space has configured. Expect fields covering things like industry/niche, product description, target audience, tone, writing style, values, formatting conventions, preferred and forbidden terminology, and market-specific notes — but **treat the returned field set as the source of truth**, not this list. Apply every field that comes back; ignore any this list mentions that the space doesn't actually set.

## If the fetch fails

There is no baked-in fallback copy of these guidelines, by design — a stale snapshot silently applied is worse than a flagged gap.

If the tool errors, is unavailable, or returns no guideline fields:

1. Do **not** invent brand voice, and do **not** fall back to generic marketing tone as though it were the brand's.
2. Continue the run — a finished page with flagged voice uncertainty is more useful than no page.
3. Write in plain, neutral, factual language drawn strictly from the source material you were given.
4. **State plainly in your final summary that brand guidelines could not be fetched**, name the error, and flag that all copy needs a human voice pass before publishing.

## Applying them

- Apply the guidelines consistently across every locale you localize into, not just the default language.
- Storyblok's AI translation does not know this brand's voice. After each translation, re-check the result against the tone/terminology fields and adjust wording that reads off.
- Terminology rules (preferred phrasings, words to avoid, words never to use) apply to alt text and SEO metadata too, not only body copy.
