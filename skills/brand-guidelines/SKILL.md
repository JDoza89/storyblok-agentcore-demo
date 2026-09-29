---
name: brand-guidelines
description: Apply the space's live brand voice guidelines (already fetched into the Space context) to drafting, localizing, alt text, and SEO metadata.
---

# Brand Guidelines

The harness fetches the space's AI Branding settings at the start of every session and puts them in the **Space context** section of your system prompt, under "Brand guidelines". Those are authoritative for this run. They're edited in Storyblok by people who expect their edits to take effect immediately, so never substitute guidelines you remember from elsewhere or your own assumptions about the brand.

Apply every field that came back (tone, writing style, formatting, values, preferred and forbidden terminology, market-specific notes). Ignore fields the space leaves empty.

## If the guidelines couldn't be fetched

The Space context says so when the fetch failed. There's no baked-in fallback copy, by design; a stale snapshot applied silently is worse than a flagged gap.

1. Don't invent a brand voice, and don't fall back to generic marketing tone as though it were the brand's.
2. Continue the run. A finished page with flagged voice uncertainty is more useful than no page.
3. Write plain, neutral, factual copy drawn strictly from the brief.
4. **State in your final summary that brand guidelines couldn't be fetched**, name the error, and flag that all copy needs a human voice pass.

## Applying them

- Apply the guidelines in every locale, not only the default language, including any market-specific notes.
- Storyblok's AI translation doesn't know this brand's voice. After each translation, re-check the result against the tone and terminology fields and fix wording that reads off.
- Terminology rules apply to alt text and SEO metadata too, not only body copy.
