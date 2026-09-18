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

**Story-reference fields hold story `uuid` strings, never numeric story ids.** These are the fields whose schema type is `options`/`option` with `source: "internal_stories"` (a "Reference"/"Multi-Reference" field in the UI) — e.g. a `products` field listing related products. Storyblok resolves the reference by uuid; a numeric id in that array silently resolves to nothing, so the field looks populated in the API response while the frontend renders an empty list.

```json
// wrong — these are story ids
"products": ["221143137047892", "221140279162191"]

// right — story uuids
"products": ["af89ca3b-c7c3-4298-991e-03c00f15e18b", "6c1e0f2d-40aa-4c8e-b3a1-9f77b2d5e014"]
```

Every story object carries **both** `id` and `uuid`, and they sit next to each other in the same response — that adjacency is exactly why this goes wrong. The listing that finds the story is also the listing that hands you the wrong value first. Ask for `uuid` in `fields`, and the moment you match a story, write down its uuid and **discard its id** — don't carry both forward to the payload-building step and decide between them later, because by then they're two plausible-looking numbers in your notes.

**Check the shape before you send.** A uuid is 36 characters, `8-4-4-4-12` hex with dashes (`af89ca3b-c7c3-4298-991e-03c00f15e18b`). An id is bare digits (`221143137047892`). Before any `createStory`/`updateStory`, look at every value in every story-reference field: **if it is all digits, it is an id and the write is wrong** — stop and go get the uuid. This check costs nothing and catches the mistake every time, so run it every time, including on update runs where you're only touching one field.

Never derive, shorten, or invent a uuid, and never fall back to the id because the uuid wasn't in the response — go re-read the story. If you can't resolve a referenced story at all, leave the entry out and flag it rather than writing an id in its place.

**The field's own schema tells you where its stories live.** A story-reference field carries `folder_slug` (e.g. `"products/"`) and `filter_content_type` (e.g. `["productPage"]`) — that's the exact folder and content type the field accepts, straight from the live schema. Scope your search with those rather than guessing where to look. A story that fails the field's `filter_content_type` is not a valid value for it, however well its name matches.

Single-reference fields (`option`, same `internal_stories` source) take one uuid string, not an array — the same shape check applies. `multilink` fields are a different type again — a link object, with the uuid under `id` plus `"linktype": "story"`, so a bare digit string is wrong there too. Read the field's real type from the live schema before shaping the value.

**Localized values sit beside their default-language field**, same field name plus `__i18n__<lang>` (e.g. `description__i18n__de`) — never as a separate translated story. Only fields with actual translatable content get one; `_uid`, `component`, link objects, asset objects, and story-reference uuids never do — a translated uuid is a broken reference.

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
- **Other products this one should link to** — named in prose, never in a labelled field. A brief mentions them because a human reading it would know to cross-link: a predecessor or later generation, a sibling in the same line or family, a bundled or companion item, an accessory, a variant it replaces or sits alongside. The wording differs every time ("the second generation of X", "stays on sale while stock lasts", "pairs with", "the rest of the Y range") and so does the product category — read for the relationship, not for a phrase. Step 2.7 resolves them to stories; step 3 places them.
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

1. **Parse the brief.** Extract the fields above. If something this workflow depends on is missing (target markets, core benefits, referenced assets), note the gap explicitly rather than inventing content — flag it in the final summary. Write down the other products the brief names, in the brief's own words, as candidates for step 2.7 to resolve.

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

   7. **Resolve related products to story uuids.** For each product the brief named in step 1, find its story and read its `uuid`:
      1. Scope the search with the reference field's own `folder_slug` and `filter_content_type` from 2.1 — list the stories in that folder of that content type (`listStories` with `folder_slug`/`starts_with` and `content_type`, asking for `name`, `slug`, `uuid`). One listing covers every candidate, so don't search per product. If a named product isn't in that listing, widen once to a space-wide search by name; if it turns up outside the field's folder or content type, it is not a valid value for that field — flag it rather than forcing it in.
      2. Match each candidate against that listing on the product name, allowing for the brief's shorthand: a generation number written as a word or a digit, a first generation written without its number at all, a name with the line prefix dropped, a trailing descriptor the story title omits. Match on the product, not on string equality.
      3. **Record only `name → uuid`.** Write the pair down that way and drop the `id` from your notes entirely — the id has no use anywhere in the rest of this run, and the only reason it ever reaches a reference field is that someone kept it around. See *Story-reference fields* above for the shape check.
      4. **One ambiguous or missing match doesn't sink the rest.** Resolve the ones you can, drop the ones you can't, and flag each unresolved name in the final summary with what you searched for. Never guess between two plausible stories, and never point a reference at this run's own story.
      5. If the brief names no other products, or none of them exist in the space yet, the reference field stays empty — that's a normal outcome, not a failure.

   8. **Resolve every other story-reference field the same way.** Related products is the obvious one, but it is not the only reference field you'll meet — a variant's colorway, a testimonial's customer profile, and anything else the schemas in 2.1 reported as `options`/`option` with `source: "internal_stories"` all take uuids and all need resolving here, in this read pass, against their own `folder_slug`/`filter_content_type`. The brief flags these in prose too ("merchandising maintains the colorway list centrally", named customers who agreed to be quoted). Where the referenced stories don't exist yet, leave the field empty and flag it — don't fall back to writing the value inline in a text field, and never write an id.

   After this pass, everything else is drafting (no tool calls) followed by writes. The only further reads are the fresh-fetch-before-write re-checks required around `updateStory`.

3. **Write the page.** Build the `productPage` story using **only** components from step 2.1's whitelist, with **only** the field names their live schemas reported.

   Map the brief onto whatever that whitelist actually offers, by matching intent to each component's real purpose and fields — a hero-like component for the value proposition, a repeatable card-like group for core benefits, a gallery-like component for photography, a table-like component for structured specs, a signup-like component for a waitlist ask, a link/button component for a referenced PDF. **If the whitelist has no reasonable home for something in the brief, skip that content and flag it** — do not invent a component, and do not stretch an unrelated one to fit. Equally, if the whitelist offers something useful the brief didn't anticipate, using it is fine.

   **Related products.** Put the uuids from step 2.7 into whichever component and field the live whitelist actually offers for cross-linking products — a component whose purpose is related/recommended products, or a story-reference field on one you're already using. Identify it by what its schema says it is (`options` with `source: "internal_stories"`, pointing at product stories), not by hoping for a particular name; the field could be `products`, `related`, `related_products` or anything else, and the component holding it could equally be named for the section the brief describes. If the whitelist has no such field anywhere, skip the cross-linking and flag it rather than writing the product names into body copy as a substitute.

   The brief may also say where the links belong and what to call the section ("a 'More from the Aurora line' section near the bottom"). Honor placement when the component's position is yours to choose, and treat a quoted section title as the brief's intent for a heading field — rewritten in the brand's voice like any other copy, not pasted.

   **Before you send the payload, run the uuid shape check.** Walk every story-reference field in the content you just built and confirm each value is `8-4-4-4-12` hex, not bare digits. A digits-only value means an id slipped through from step 2.7 — fix it before writing, not after.

   - **Create path:** `createStory` under the folder from step 2.2, with `content.component` set to `productPage`.
   - **Update path:** `updateStory` on the existing story id from step 2.4 — the destructive-overwrite rule above is mandatory here, not optional.

   **After the write, re-fetch the story and read the reference fields back.** A `200` is not proof (see above). Confirm each one holds the uuids you intended — same count, same values, uuid-shaped. If any came back as digits, empty, or short, fix it now and say so in the final summary rather than reporting the links as done.

4. **Localize.** For each target market from the brief, run the localization procedure above — once per locale, after the story exists. On an update run, skip locales whose relevant fields didn't change; do translate any newly enabled locale or one whose changed fields need it. After each, spot-check tone against the brand guidelines and adjust. If a locale isn't enabled on the space, flag it rather than silently skipping.

5. **Generate metadata.** Alt text for every new image, plus SEO title/description per locale, written into whatever `productPage`'s live schema showed its SEO/meta fields to be. On an update run, only touch metadata tied to what actually changed.

6. **Move to review.** `createWorkflowStageChange` to the stage id from step 2.3. Never attempt to publish directly — this agent does not have publish rights and should not work around that.

7. **Stop.** Summarize what was built or changed (say explicitly whether this was a create or an update, and if an update, exactly what changed), which components the live whitelist offered and which you used, which related products you linked and which named products you couldn't resolve, which locales completed, and every gap flagged along the way — including any component whose schema fetch failed. A human reviews and publishes from the Visual Editor.
