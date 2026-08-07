---
name: productBrief-to-storyblokPage
description: Turn a product-launch brief into a Storyblok landing page — assemble approved components, localize into target markets, generate alt text and SEO metadata, and move the story into the pre-publish workflow stage for human review.
---

# Product Brief → Storyblok Page

## Space

Every Storyblok tool call in this skill operates on **space_id `{{SPACE_ID}}`**, region **`us`**. Both are fixed for this deployment — never ask for either, never guess a different value.

The **Reviewing** workflow stage — where finished stories go (see workflow step 6) — is **`workflow_stage_id 205840442735385`**. This is fixed for this deployment; don't spend a tool call rediscovering it via `listWorkflowStages`.

Every story this skill creates or updates is a **`productPage`** (not `page`), living under the **Products** folder — **`parent_id 206598384073576`**. Both are fixed for this deployment; don't spend a tool call rediscovering them.

`productPage`'s `body` field is restricted to a whitelist of components — **but don't trust a hardcoded list for this.** The content model can change, so workflow step 2 always fetches the live `productPage` schema and reads its `body.component_whitelist` fresh, every run. Whatever that live fetch returns is the complete, authoritative set of components you may use that run — never fall back to memory, to a previous run, or to a component that merely sounds right for a landing page (e.g. anything for team bios or testimonials is never part of this content type). As of this writing that list happens to be `button`, `card`, `cards`, `emailSignup`, `gallery`, `hero`, `specTable` — shown here only so the field reference table below means something, not as something to trust without checking.

## Don't get stuck — finish all 7 steps before polishing anything

A completed page in the Reviewing stage with an imperfect field beats a perfect field on a page that never gets there. If you're unsure of a field's exact shape (e.g. a `table` field's structure), make one best-effort attempt using the examples in this skill, note the uncertainty in your final summary, and **move on immediately** — don't spend more than one extra tool call re-confirming something you're already unsure about. Every run must reach step 6 (move to Reviewing) and step 7 (final summary) — a run that stops partway through with no summary is a failure even if the story it created looks fine.

**A `200`/success response is not proof the operation did what you intended** — Storyblok's API can return success while silently no-op'ing (this is confirmed true for `ai_translate_language`; assume it could be true elsewhere too). Before claiming something worked in your final summary, re-fetch and check the actual result. If you can't confirm it worked, say so plainly instead of reporting success — a summary that overclaims is worse than one that honestly flags a gap.

## Calling `execute_mutating` / `execute_readonly` correctly

These two tools take exactly two arguments: `operation` (the operationId from `search`/`describe`) and `parameters` (a single flat object). There is no separate `body` or `requestBody` argument, and `describe`'s output showing a `requestBody` schema does NOT mean you should wrap your payload in a key literally called `requestBody` or `body` — that will fail with "Request body is required for this operation".

Instead: put every value flat inside `parameters` — path params, query params, AND the request body's top-level property (e.g. `story`, `component`, `workflow_stage_change`) all as sibling keys of the same object. Whatever `describe` names as the request body's top-level property, nest your data under exactly that name, directly inside `parameters` — never add an extra wrapper key on top of it.

**Create the story:**

```
execute_mutating(
  operation: "createStory",
  parameters: {
    "space_id": {{SPACE_ID}},
    "story": {
      "name": "Aurora Trail 2 Launch",
      "slug": "aurora-trail-2",
      "parent_id": 206598384073576,
      "content": { "component": "productPage", "body": [ /* your assembled component tree, using only the 7 whitelisted components */ ] }
    }
  }
)
```

**Move it to Reviewing** (do this as soon as content assembly succeeds — see the step above):

```
execute_mutating(
  operation: "createWorkflowStageChange",
  parameters: {
    "space_id": {{SPACE_ID}},
    "workflow_stage_change": {
      "workflow_stage_id": 205840442735385,
      "story_id": <the story id returned by createStory>
    }
  }
)
```

**A `specTable`'s `specs` field** (Storyblok's native `table` field type) is not a plain object of key/value pairs — it needs a `thead`/`tbody` structure, each cell its own object:

```json
{
  "thead": [
    {"_uid": "h1", "value": "Weight", "component": "_table_head"},
    {"_uid": "h2", "value": "Stack height", "component": "_table_head"}
  ],
  "tbody": [
    {
      "_uid": "r1",
      "component": "_table_row",
      "body": [
        {"_uid": "c1", "value": "285g", "component": "_table_col"},
        {"_uid": "c2", "value": "32mm / 28mm", "component": "_table_col"}
      ]
    }
  ]
}
```
If the brief doesn't give you real spec values to fill this with (e.g. it only references a spec sheet PDF without listing the numbers), it's fine to leave `specs` with an empty `thead`/`tbody` — just flag in your final summary that the spec table has no data yet.

**Localize into a target market** (see workflow step 4 — after the story already exists, one pass per locale). There is no query-param shortcut on `updateStory` for this — `ai_translate_language` as a bare `updateStory` param does NOT work (confirmed by direct testing: it returns HTTP 200 but never actually translates anything). The real mechanism, confirmed working end-to-end:

1. Call the `ai_translate_story` tool with the story's id and the target `lang` code (e.g. `"de"`, `"ja"`). This tool triggers Storyblok's AI-translate job AND waits for it to genuinely finish (it polls internally) before returning — you don't need to poll anything yourself. **Storyblok saves the translated content directly onto the story once the job completes — there is no separate `updateStory` call to make.**
2. After the tool returns success, fetch the story fresh (plain `getStory`, no `?language=` param — it doesn't reliably surface these fields on this API) and look for `<field>__i18n__<lang>` suffixed keys alongside the normal fields (e.g. `description__i18n__de`) — that's where the translated text actually lives. Confirm it's real translated text, not a copy of the default-language value, before reporting that locale as done.
3. If the tool reports it timed out or the job disappeared before reaching 100%, don't assume it worked — check for the `__i18n__` fields anyway (per step 2), but if they're not there, report this locale as failed/incomplete rather than guessing.

**CRITICAL, confirmed by real failure: `updateStory` replaces `story.content` in full, and this has actually destroyed a story's body in production — a run once left a story with `content: {"component": "page"}` and no `body` at all, because the localization step sent incomplete content.** This is not a hypothetical risk. Follow this exactly, every single time you call `updateStory` for any reason (localization or otherwise):

1. **Immediately before building the payload**, call `getStory` (or equivalent readonly fetch) fresh — do not reuse a content object you remember from an earlier step, even a few tool calls ago. Use exactly what comes back.
2. Take that fetched `content` object whole, modify only the specific thing you intend to change (if anything), and send that complete object back as `story.content`. Never send a partial object, never send `{"component": "page"}` alone, never omit `body`.
3. **After the call returns, re-fetch the story and confirm `content.body` is present and has the same number of blocks as before.** If `body` is missing, empty, or shorter than expected, you have just destroyed the page — stop immediately, do not proceed to further locales or steps, and say so plainly in your final summary rather than continuing as if nothing happened.

The same fresh-fetch-and-verify discipline applies to localization specifically (step 3 of the localize instructions above) — persisting a translation is just another `updateStory` call, with all the same destructive-overwrite risk.

## Component field reference

Use these exact field names when building the `body` array — do not invent plausible-looking alternatives (e.g. `title`/`subtitle`/`cta_text`/`cta_link`/`label` do **not** exist on any of these components, even though they sound reasonable for a landing page). This table covers the components in the current `productPage` whitelist (confirmed against the live schema as of writing this skill) — but the whitelist itself must always come from the live fetch in workflow step 2, not from this table. If that live fetch ever returns a component not listed here, call `getComponent`/`listManagementComponents` for that specific component to learn its fields rather than guessing.

| Component | Fields |
|---|---|
| `hero` | `image` (**asset — full object, see below**), `imagePadding` (boolean), `backgroundColor` (option), `textAlignment` (option: `left`/`right`/`center`), `description` (**richtext** — see below), `buttons` (bloks, `button` components) |
| `button` | `text` (text), `link` (multilink), `color` (option: `primary`/`secondary`) |
| `card` | `icon` (**asset — full object**), `description` (**richtext**) |
| `cards` | `description` (richtext), `cards` (bloks, `card` components) |
| `gallery` | `title` (text), `images` (**multiasset — array of full asset objects**, see below) |
| `specTable` | `title` (text), `specs` (table — see the `thead`/`tbody` shape above) |
| `emailSignup` | `heading` (text), `description` (text — plain string, NOT richtext, unlike most other `description` fields), `buttonText` (text), `successMessage` (text) |
| `productPage` | `body` (bloks — the top-level array, restricted to the 7 components above), plus SEO-tab fields `meta_title`, `meta_description`, `og_image` (**asset — full object**) |

**`richtext` fields are ProseMirror doc objects, not plain strings** — e.g. `{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "your copy here"}]}]}`. Do not pass a bare string for any `description` field.

**`asset`/`multiasset` fields are full objects, never a bare `{"id": ...}`** — see the CRITICAL note under workflow step 3 for the exact shape and a real example. This applies to `hero.image`, `card.icon`, `gallery.images` (each array entry), and `productPage.og_image`.

## On invocation

The input to this skill is whatever the caller pasted in — it might be a real brief, a fragment, or something unrelated. Before doing anything else:

1. Check whether it's plausibly a product-launch brief: does it name an actual product, and does it contain at least some of target audience, benefits/value proposition, or launch timing? A brief doesn't need every field (see below), but it needs to be recognizably about launching a specific product.
2. If it passes that check, **proceed through the full workflow below autonomously** — don't pause to ask the caller for confirmation between steps, don't ask which components to use, don't ask for the space ID. Get to work and report back only once the story is in review (step 7), or if you hit one of the explicit stop conditions in steps 1 or 4 of the workflow.
3. If it clearly isn't a product brief (e.g. no identifiable product, or unrelated content entirely), say so plainly and stop rather than guessing at what to build.

## What a product brief looks like

Briefs arrive as free-form text or a doc export — there's no fixed schema — but they consistently carry the same handful of facts, modeled here on real-world product-marketing brief templates (Shopify's product marketing brief, Asana's product brief). Look for these fields regardless of how the brief is formatted or ordered:

- **Product name / working title**
- **Launch date(s)** — projected launch date, and separately a comms/announcement date if one is given
- **Target audience** — who this is for, described concretely enough to inform tone (not just a demographic label)
- **Core benefits / value proposition** — the 2-4 things being sold, usually phrased as "what we're selling / why it matters / the payoff"
- **Target markets or locales** — which countries/languages this page needs to exist in
- **Assets referenced** — product photography, video, spec sheets; note what's referenced even if the file itself isn't attached, so the page can flag missing assets rather than fabricate them
- **Success metrics** (optional) — useful context for what the page should emphasize, not something the page itself displays

### Example brief (e-commerce)

```
PRODUCT MARKETING BRIEF
Product: Aurora Trail 2 — trail running shoe
Launch date: 2026-09-15 (comms/teaser starts 2026-09-01)
Markets: US (en), Germany (de), Japan (ja)

Target audience
Weekend trail runners, 25-40, who've outgrown road-running shoes but
aren't ultra racers. They're gear-curious, price-sensitive above $160,
and influenced by reviews more than ads.

Core benefits
- Dual-density foam midsole — cushioned on descents, stable on climbs
- Recycled-mesh upper (60% post-consumer content) — breathable, durable
- 4mm lugs, sticky rubber outsole — reliable grip on wet rock and roots

Value proposition
What we're selling: a trail shoe that doesn't force a tradeoff between
cushioning and stability.
Why it matters: most shoes at this price pick one or the other.
The payoff: fewer rolled ankles on technical descents, less fatigue
on long days.

Assets
- Product photography (6 angles, studio + on-trail) — in DAM under
  "Aurora Trail 2 / Launch"
- 15s hero video (on-trail action shot)
- Spec sheet PDF (weight, drop, stack height, sizing)

Success metrics
Awareness: press pickup in 3 trail-running outlets by launch.
Acquisition: 500 waitlist signups pre-launch.
```

## Workflow

1. **Parse the brief.** Extract the fields above. If a field this workflow depends on is missing (target markets, core benefits, or referenced assets), note the gap explicitly rather than inventing content to fill it — flag it in the final summary to the human reviewer instead of guessing.

2. **Gather what you need before drafting anything — this read-only pass is the only round of Storyblok reads this workflow should need.** Do these four things, in any order, before writing a single field:

   1. **Fetch the live component whitelist.** Look up the `productPage` component's current schema (e.g. search components for `productPage`) and read its `body` field's `component_whitelist`. This is the complete, authoritative list of components you may use this run — see the Space section above. Don't reuse a whitelist from memory or a previous run.
   2. **Check whether this product already has a page.** Search stories under the Products folder (`parent_id 206598384073576`) for one matching this brief's product (by name or an obvious slug match).
      - **If one exists, this run is an update, not a create.** Fetch its full current content and compare it against the brief: identify only what's actually new or different (new/changed benefits, a different launch date, copy that no longer matches, newly-referenced assets, a market not yet localized, etc.). Leave everything unchanged alone in step 3 — the goal is a targeted edit, not a full re-draft from scratch.
      - **If none exists, this run is a create.** Proceed normally in step 3.
   3. **Fetch brand guidelines.** Follow the `brand-guidelines` skill once per run, regardless of create or update.
   4. **Locate real assets.** When the brief says an asset lives "in [Assets/DAM] under '<some folder name>'", that's a real Storyblok asset folder — find it, don't guess:
      1. Call `listAssetFolders` and match the brief's referenced location against the folder names returned (fuzzy match is fine — e.g. "Aurora Trail 2 / Launch" in the brief matching a folder literally named that).
      2. Call `listAssets` with `in_folder: <that folder's id>` to get the real asset objects.
      3. Pick sensibly by filename where it's obvious (e.g. a file named `hero.jpg` for the hero component's image, the rest for the gallery) — don't just grab the first N arbitrarily.
      4. These assets likely have empty `alt` text already (check first) — you still need to write real, descriptive alt text for each one as part of step 5, even when the image itself is real.
      5. Only fall back to a placeholder asset if you searched and genuinely found no matching folder or no assets in it — and say so explicitly in your final summary. Don't reach for a placeholder just because the first thing you tried didn't surface it.

   Once these four reads are done, everything else in this workflow is drafting (no tool call) followed by writes — the only further reads you should need are the fresh-fetch-immediately-before-write re-checks already required around any `updateStory` call (see the CRITICAL note above), which exist purely to avoid clobbering content, not to gather new information.

3. **Write the page.** Use only the components from step 2.1's live whitelist to build or update the `productPage` story via the Storyblok MCP tools, in space `{{SPACE_ID}}`. Do not invent new component types and do not reach for anything outside that whitelist — there is no team-bio or testimonial component available on a product page, so briefs mentioning that kind of content should simply skip it. Map brief fields to page structure directly: core benefits → feature/benefit blocks (the `cards`/`card` components), value proposition → hero copy (`hero`), product photography → the `gallery` component, a referenced spec sheet PDF → a `button` linking directly to the asset, structured specs → `specTable`, a waitlist/early-access ask → `emailSignup`.

   - **Create path:** `createStory` under the Products folder (exact call shape above).
   - **Update path:** `updateStory` on the existing story id from step 2.2 — but the fresh-fetch-immediately-before-write discipline in the CRITICAL note above is mandatory here, not optional: fetch the story's content again right before building the payload (don't reuse the copy from step 2.2, even though it was recent), change only what step 2.2 identified as different, and re-fetch afterward to confirm `content.body` still has every block it should.

   **CRITICAL — an asset reference is a full object, not just an id.** `listAssets` returns `id`, `filename`, `alt`, `title`, `copyright`, `focus` for each asset — every `asset`/`multiasset` field value (`hero.image`, `card.icon`, `gallery.images`, `productPage.og_image`) must be the **complete object**, not `{"id": 123}` alone. `filename` is the actual CDN URL the live frontend renders as the `<img>` src — omit it and the image is broken on the real site, not just missing. Always include `"fieldtype": "asset"` too. Example, using a real asset from this space:
   ```json
   {
     "id": 206261088512839,
     "filename": "https://a-us.storyblok.com/f/{{SPACE_ID}}/1920x683/b17642d674/hero.jpg",
     "alt": "Aurora Trail 2 trail running shoe, side profile, studio lighting",
     "title": "",
     "copyright": "",
     "focus": "",
     "fieldtype": "asset"
   }
   ```
   This applies identically to placeholder assets too — a placeholder is still a real asset id you found via `listAssets`/`listAssetFolders`, so it still needs its full object, not a bare id.

4. **Localize.** There is no separate "create a translated story" operation — translations live as extra fields on the *same* story, keyed by language. For each target market/locale from the brief, use the `ai_translate_story` tool followed by `updateStory` to persist (exact two-step call shape above) — do this once per locale, after the story exists (step 3), not before. On an update run, skip re-translating a locale whose relevant fields didn't change in step 3 (no point spending a translation job on text that's already been translated) — but do translate any locale that's newly enabled or whose changed fields need it. After each translation, spot-check the tone against the brand guidelines from step 2 (Storyblok's generic AI translation won't itself know your brand voice) and adjust wording for that locale's fields if it reads off. If a target locale isn't enabled on the space yet, flag it rather than silently skipping it or guessing.
5. **Generate metadata.** Alt text for every new image, SEO title/description per locale, using the `productPage` component's SEO tab fields (`meta_title`, `meta_description`, `og_image`). On an update run, only touch metadata tied to what actually changed — don't regenerate alt text or SEO copy for images/fields step 2.2 already found unchanged.
6. **Move to review.** Move the story to the **Reviewing** workflow stage using `createWorkflowStageChange` (exact call shape above). Never attempt to publish directly — this agent does not have publish rights, and should not try to work around that.
7. **Stop.** Once the story is in the Reviewing stage, summarize what was built or changed (say explicitly whether this was a create or an update, and if an update, exactly what changed), which locales were completed, and any gaps flagged in step 1 or step 4. A human reviews and publishes from the Visual Editor.
