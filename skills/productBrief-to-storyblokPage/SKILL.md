---
name: productBrief-to-storyblokPage
description: Turn a product-launch brief into a Storyblok landing page — assemble approved components, localize into target markets, generate alt text and SEO metadata, and move the story into the pre-publish workflow stage for human review.
---

# Product Brief → Storyblok Page

## Space

Every Storyblok tool call in this skill operates on **space_id `{{SPACE_ID}}`**, region **`{{REGION}}`**. Both are fixed for this deployment — never ask for either, never guess a different value.

Everything else about this space — which components exist, what fields they have, where stories live, which workflow stages are defined — **is discovered live in step 2, every run.** This skill deliberately contains no snapshot of the content model. The model changes without this skill changing, so anything remembered here would eventually be wrong in a way that's hard to notice. If you catch yourself about to use a component name, field name, folder id, or stage id that you did not read from a tool result *this run*, stop and go fetch it.

Stories this skill creates are of the **`productPage`** content type. That is the one structural fact this skill asserts — it's the skill's subject. Everything about `productPage` (its whitelist, its fields, its SEO fields) still gets read live.

## Don't get stuck — finish all 7 steps before polishing anything

A completed page in the review stage with an imperfect field beats a perfect field on a page that never gets there. If you're unsure of a field's exact shape, make one best-effort attempt, note the uncertainty in your final summary, and **move on immediately** — don't spend more than one extra tool call re-confirming something you're already unsure about. Every run must reach step 6 (move to review) and step 7 (final summary) — a run that stops partway through with no summary is a failure even if the story it created looks fine.

**A `200`/success response is not proof the operation did what you intended** — Storyblok's API can return success while silently no-op'ing (confirmed true for `ai_translate_language`; assume it could be true elsewhere). Before claiming something worked in your final summary, re-fetch and check the actual result. If you can't confirm it worked, say so plainly instead of reporting success — a summary that overclaims is worse than one that honestly flags a gap.

## Storyblok field types you will meet

These are properties of Storyblok's field *types*, not of any particular component, so they hold regardless of what the live schema turns out to contain. Use the live schema to learn which of a component's fields are which type, then shape the value accordingly.

**`richtext` fields are ProseMirror doc objects, not plain strings** — e.g. `{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "your copy here"}]}]}`. Never pass a bare string to a richtext field. Note that a field being *named* something like `description` tells you nothing — on one component it may be richtext, on another plain text. Check the live schema per component.

**`asset` / `multiasset` fields are full objects, never a bare `{"id": ...}`.** `listAssets` returns `id`, `filename`, `alt`, `title`, `copyright`, `focus` — pass the complete object, plus `"fieldtype": "asset"`. `filename` is the actual CDN URL the live frontend renders as the `<img>` src; omit it and the image is broken on the real site, not merely missing. A `multiasset` value is an array of such complete objects. This applies to placeholder assets too — a placeholder is still a real asset id you found via `listAssets`, so it still needs its full object.

```json
{
  "id": 123456789,
  "filename": "https://a-<region>.storyblok.com/f/<space>/<dims>/<hash>/<file>.jpg",
  "alt": "Descriptive alt text you wrote in step 5",
  "title": "", "copyright": "", "focus": "", "fieldtype": "asset"
}
```

**`table` fields** need a `thead`/`tbody` structure, each cell its own object — not a flat key/value map:

```json
{
  "thead": [
    {"_uid": "h1", "value": "<column heading>", "component": "_table_head"}
  ],
  "tbody": [
    {"_uid": "r1", "component": "_table_row",
     "body": [{"_uid": "c1", "value": "<cell value>", "component": "_table_col"}]}
  ]
}
```
If the brief gives you no real values for a table (e.g. it references a spec-sheet PDF without listing numbers), leaving `thead`/`tbody` empty is fine — flag it in your final summary.

**`bloks` fields** hold an array of nested component objects. Each entry needs its own `component` name and `_uid`. Which components an individual `bloks` field accepts is itself a live fact — read that field's `component_whitelist` from the schema, exactly as you do for the root `body` field.

**Localized values sit beside their default-language field**, same field name plus `__i18n__<lang>` (e.g. `description__i18n__de`) — never as a separate translated story. Only fields with actual translatable content get one; `_uid`, `component`, link objects, and asset objects never do.

## The destructive-overwrite rule

**`updateStory` replaces `story.content` in full, and this has actually destroyed a story's body in production** — a run once left a story with `content: {"component": "page"}` and no `body` at all, because the localization step sent incomplete content. This is not hypothetical. Follow this exactly, every time you call `updateStory` for any reason:

1. **Immediately before building the payload**, call `getStoryById` fresh — do not reuse a content object you fetched earlier, even a few tool calls ago. Use exactly what comes back.
2. Take that fetched `content` object whole, modify only the specific thing you intend to change, and send that complete object back as `story.content`. Never send a partial object, never send just `{"component": "..."}`, never omit `body`.
3. **After the call returns, re-fetch and confirm `content.body` is present with the same number of blocks as before.** If `body` is missing, empty, or shorter than expected, you have destroyed the page — stop immediately, do not proceed to further locales or steps, and say so plainly in your final summary.

## Localizing

There is no query-param shortcut on `updateStory` — `ai_translate_language` as a bare `updateStory` param does NOT work (confirmed: returns HTTP 200 but never translates). The mechanism that does work:

1. Call the `ai_translate_story` tool with the story's id and target `lang` code. It triggers Storyblok's AI-translate job **and waits for it to finish** — you don't poll anything yourself. Storyblok saves the translated content directly onto the story; **there is no follow-up `updateStory` to make.**
2. After it returns success, fetch the story fresh (plain `getStoryById`, no `?language=` param — it doesn't reliably surface these fields) and look for `__i18n__<lang>` keys. Confirm it's real translated text, not a copy of the default-language value, before reporting that locale done.
3. If the tool reports a timeout or that the job vanished before 100%, don't assume it worked — check for `__i18n__` fields anyway; if absent, report the locale failed rather than guessing.

## On invocation

The input is whatever the caller pasted — a real brief, a fragment, or something unrelated. Before doing anything else:

1. Check whether it's plausibly a product-launch brief: does it name an actual product, and carry at least some of target audience, benefits/value proposition, or launch timing?
2. If it passes, **proceed through the full workflow autonomously** — don't pause for confirmation between steps, don't ask which components to use, don't ask for the space id.
3. If it clearly isn't a product brief, say so plainly and stop rather than guessing at what to build.

## What a product brief looks like

Briefs arrive as free-form text or a doc export — no fixed schema — but consistently carry the same handful of facts. Look for these regardless of formatting or order:

- **Product name / working title**
- **Launch date(s)** — projected launch, plus a separate comms/announcement date if given
- **Target audience** — concrete enough to inform tone, not just a demographic label
- **Core benefits / value proposition** — the 2-4 things being sold ("what we're selling / why it matters / the payoff")
- **Target markets or locales** — which countries/languages this page needs
- **Assets referenced** — photography, video, spec sheets; note what's referenced even if not attached, so the page can flag missing assets rather than fabricate them
- **Success metrics** (optional) — context for what the page should emphasize, not something the page displays

## Write in the brand's voice, not the brief's

**The brief is source material, not copy.** It tells you *what is true* about the product — benefits, specs, audience, dates, what ships in the box. It does not tell you how to say any of it, and its own phrasing is internal marketing shorthand written for colleagues, not customers.

Every word that lands on the page is drafted by you, from the brief's facts, in the voice the `brand-guidelines` skill returned this run. That means:

- **Never paste brief text straight onto the page.** Bullet fragments like "Dual-density foam midsole — cushioned on descents, stable on climbs" are notes. Rewrite them as customer-facing copy that follows the live tone, writing-style, and formatting rules.
- **Apply the terminology rules.** Preferred phrasings, words to avoid, and words never to use all apply to body copy, headings, alt text, and SEO metadata alike.
- **Keep every fact verifiable.** Rewriting changes the wording, never the substance — don't round a number, drop a unit, soften a qualifier, or add a claim the brief doesn't support. If the brief gives a figure with a unit or a certification, carry it through exactly.
- **Don't invent what isn't there.** If the brief is silent on something a component wants, leave it empty and flag it rather than writing plausible filler.
- **If the guidelines fetch failed**, follow the fallback in `brand-guidelines`: neutral factual copy, and flag in your summary that everything needs a human voice pass.

## Workflow

1. **Parse the brief.** Extract the fields above. If something this workflow depends on is missing (target markets, core benefits, referenced assets), note the gap explicitly rather than inventing content — flag it in the final summary.

2. **Discover the live content model and everything else you need.** This read-only pass is where every structural fact comes from. Nothing in this skill substitutes for it.

   1. **Fetch the `productPage` schema, then the schema of every component it allows.** Look up `productPage` (e.g. `search` components for it, then `getComponent`) and read its `body` field's `component_whitelist`. **That list is the complete and only set of components you may use this run.** Then fetch each whitelisted component's own schema to learn its real field names and types.

      Build yourself a field map from these results and work only from it. If a component's schema fetch fails, do not guess its fields from its name — skip that component and flag it in your final summary. If a whitelisted component contains a nested `bloks` field, read that field's own `component_whitelist` too.

      Also read `productPage`'s remaining fields here — its SEO/meta fields (whatever they're actually called in this space) are what step 5 writes to.

   2. **Resolve where stories live.** Find the folder these product stories belong in — list stories/folders and match on a folder whose name indicates products. Use the id you get back as `parent_id`. If you can't find one, create at the space root and flag it.

   3. **Resolve the review workflow stage.** Call `listWorkflowStages` and pick the stage representing pre-publish human review (typically named something like "Reviewing" or "In review"). Use that id in step 6. If you can't identify one unambiguously, flag it and pick the closest match rather than skipping step 6.

   4. **Check whether this product already has a page.** Search stories under the folder from 2.2 for one matching this brief's product.
      - **If one exists, this run is an update.** Fetch its full current content and compare against the brief: identify only what's genuinely new or different. Leave everything else alone in step 3 — a targeted edit, not a re-draft.
      - **If none exists, this run is a create.**

   5. **Fetch brand guidelines.** Follow the `brand-guidelines` skill, once per run, create or update.

   6. **Locate real assets.** When the brief says an asset lives "in [Assets/DAM] under '<folder name>'", that's a real Storyblok asset folder — find it, don't guess:
      1. `listAssetFolders` and fuzzy-match the brief's reference against the folder names returned.
      2. `listAssets` with `in_folder: <that folder's id>` for the real asset objects.
      3. Pick sensibly by filename where it's obvious — don't grab the first N arbitrarily.
      4. These assets likely have empty `alt` already (check) — you still write real alt text in step 5.
      5. Only fall back to a placeholder if you genuinely found no matching folder or no assets — and say so explicitly.

   After this pass, everything else is drafting (no tool calls) followed by writes. The only further reads are the fresh-fetch-before-write re-checks required around `updateStory`.

3. **Write the page.** Build the `productPage` story using **only** components from step 2.1's whitelist, with **only** the field names their live schemas reported.

   Map the brief onto whatever that whitelist actually offers, by matching intent to each component's real purpose and fields — a hero-like component for the value proposition, a repeatable card-like group for core benefits, a gallery-like component for photography, a table-like component for structured specs, a signup-like component for a waitlist ask, a link/button component for a referenced PDF. **If the whitelist has no reasonable home for something in the brief, skip that content and flag it** — do not invent a component, and do not stretch an unrelated one to fit. Equally, if the whitelist offers something useful the brief didn't anticipate, using it is fine.

   - **Create path:** `createStory` under the folder from step 2.2, with `content.component` set to `productPage`.
   - **Update path:** `updateStory` on the existing story id from step 2.4 — the destructive-overwrite rule above is mandatory here, not optional.

4. **Localize.** For each target market from the brief, run the localization procedure above — once per locale, after the story exists. On an update run, skip locales whose relevant fields didn't change; do translate any newly enabled locale or one whose changed fields need it. After each, spot-check tone against the brand guidelines and adjust. If a locale isn't enabled on the space, flag it rather than silently skipping.

5. **Generate metadata.** Alt text for every new image, plus SEO title/description per locale, written into whatever `productPage`'s live schema showed its SEO/meta fields to be. On an update run, only touch metadata tied to what actually changed.

6. **Move to review.** `createWorkflowStageChange` to the stage id from step 2.3. Never attempt to publish directly — this agent does not have publish rights and should not work around that.

7. **Stop.** Summarize what was built or changed (say explicitly whether this was a create or an update, and if an update, exactly what changed), which components the live whitelist offered and which you used, which locales completed, and every gap flagged along the way — including any component whose schema fetch failed. A human reviews and publishes from the Visual Editor.
