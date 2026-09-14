---
name: brand-guidelines
description: Fetch and apply the current brand voice guidelines and localization approach from Storyblok before drafting, localizing, or tagging any content.
---

# Brand Guidelines

Before drafting, localizing into any market, or generating alt text/SEO metadata, retrieve the current brand guidelines. Space_id is **`{{SPACE_ID}}`**, region **`us`** — both fixed for this deployment, never ask for either, never guess a different value.

1. **Call the `fetch_ai_branding_guidelines` tool first.** This fetches the space's real, live AI Branding settings directly. If it succeeds and returns real guideline fields, **those values are authoritative** — they're more current than the baked-in snapshot below and take priority over it.
2. **If that tool fails, is unavailable, or returns an error/empty result instead of guideline fields, use the baked-in snapshot below.** Don't try any other fetch mechanism (e.g. searching for a separate guidelines story) — this snapshot _is_ the fallback, no further lookup needed.
3. Apply whichever set of guidelines you end up using — tone, terminology, do's/don'ts — consistently across every locale you localize into.
4. Always attempt step 1 first on every run, even though it currently only works locally — don't skip straight to the fallback just because it failed on a previous run.

## Baked-in guidelines (fallback snapshot, current as of 2026-08-06)

- **industry_niche**: Outdoor/trail running footwear, direct-to-consumer. Positioned between mass-market road-running brands and cult-of-ultra mountain/racing specialists — built for the citizen trail runner.
- **brand_product_service**: Aurora makes trail running shoes for people who run trails on weekends, not people training for Hardrock. Technical enough to trust on wet rock and roots, without the price or branding of ultra-racing gear. Built for the citizen trail runner, not the FKT chaser.
- **target_audience**: Weekend trail runners, 25–40, who've outgrown road-running shoes but aren't ultra racers. Gear-curious, price-sensitive above $160, and trust reviews far more than ads.
- **tone_guidelines**: Confident, not macho. Talk like a knowledgeable friend at the trailhead, not a coach yelling motivation. Dry humor is welcome; chest-thumping ("conquer," "crush," "dominate the descent") is not.
- **writing_style**: Plain language. Concrete, sensory detail over hype adjectives. Short sentences, active voice. Lead with the tradeoff being solved ("cushioned on descents, stable on climbs"), not a generic aspiration.
- **values_or_personality_traits**: Honest, unpretentious, a little geeky about materials, environmentally conscious without being preachy, respects the reader's intelligence — never oversells.
- **formatting**: Sentence case for headings, not Title Case. Bullets for specs/benefits, not paragraphs. Bold the tradeoff being solved in benefit copy. Always pair a number with its unit ("4mm," "60%"). Oxford comma.
- **always_use**: (not set)
- **commonly_use**: "Weekend warrior," "technical terrain," real trail/condition descriptions ("wet rock and roots") instead of generic "the trails." Testing language ("we tested this on...").
- **avoid_use**: Ultra-running jargon that alienates casual trail runners (FKT, vert, hundo) unless explained inline. Motivational-poster language ("no pain no gain"). Unquantified eco-claims.
- **never_use**: Unsupported superlatives ("the best trail shoe ever"). Fear-based marketing (injury scare tactics). Competitor bashing by name. Gendered assumptions about who trail runs.
- **additional_guidelines**: For DE/JA markets: keep the directness, but drop American colloquialisms that don't translate ("weekend warrior"). Always pair a recycled-content percentage claim with its source/certification — sustainability claims get more regulatory scrutiny in the EU (Green Claims Directive).
