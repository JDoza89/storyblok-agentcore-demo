---
name: productBrief-to-storyblokPage
description: Turn a product-launch brief into a Storyblok landing page — assemble approved components, localize into target markets, generate alt text and SEO metadata, and leave the story in the review stage for a human.
---

# Product Brief → Storyblok Page

## What the harness owns, and what you own

The harness around you enforces this workflow's hard rules in code: it blocks publishing, allows only the review stage, rejects numeric ids in reference fields, blocks an `updateStory` that would drop content, and verifies the finished story itself. You don't need to police those. When a call comes back **"Blocked by the harness"**, read the reason, fix exactly that, and retry.

Your job is the part code can't do: reading the brief, choosing components, writing copy in the brand's voice, and shaping every field value correctly.

The **Space context** section of your system prompt is this session's live read of the space: the `productPage` content model and every component it allows, the review stage, folders, and brand guidelines. It is the complete and only set of components and field names you may use. Don't re-fetch schemas or stages. The only things left to look up are specific to this brief: an existing page for the product, its assets, and related stories.

## Flagging gaps

Everywhere this skill says **flag** something, call the `flag_gap` tool with a message a reviewer can act on ("The brief lists no spec values, so the spec table is empty. Add them from the spec sheet."). Flag it the moment you find it. When the gap is about one field of one block, also pass that block's `_uid`, its `component`, and the `fieldname`, so the comment is pinned to that spot in the Visual Editor. For a story-level gap (brand guidelines unavailable, a locale not enabled), pass only the message.

The harness posts every flagged gap as a comment on the story after the run, so don't post comments yourself. Still list every gap in your final summary: the summary is what reaches Slack.

## Always build the page

A completed page in review with placeholders and comments beats no page. If you're unsure of a field's shape, make one best-effort attempt, note it in your summary, and move on. Every run reaches SEO metadata, the review stage, and a final summary.

**Never ask the caller a question or wait for an answer.** Nobody may be there to see it: whatever triggered the run may only read the final result. When something is missing or ambiguous, decide, build with what you have, and flag the rest. A question in your output is a gap you didn't flag.

**Missing content becomes a placeholder, not an empty field.** When the brief doesn't give you something a component needs, fill it with a clearly marked placeholder and flag it:

- Text and richtext: `[Placeholder: <what's needed and where it comes from>]`, for example `[Placeholder: spec values from the Aurora Trail 2 spec sheet]`.
- SEO fields: a placeholder in the same form, in every locale, rather than an empty string.
- Assets: a real asset from the space as a stand-in (see step 2.2), never an empty asset object.
- Tables: one row whose cells are placeholders.
- Links (`multilink`): a URL link to `#`, as `{"linktype": "url", "url": "#", "cached_url": "#", "fieldtype": "multilink"}`, never an empty link object. This covers any link the brief doesn't give, such as a button's destination or a CTA target.
- Story references, numbers, dates, and options: leave empty. There's no safe placeholder for a uuid, a price, or a launch date. A story reference field holds uuids, so it never gets `#`; that's only for `multilink` fields.

Every placeholder gets its own `flag_gap`, pinned to its block and field, so the reviewer finds each one in the Visual Editor.

## Storyblok field types you will meet

The Space context tells you each field's type. Shape its value by type:

**`richtext`** is a ProseMirror doc object, never a bare string: `{"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "your copy here"}]}]}`. A field's name tells you nothing about its type; `description` is richtext on `hero` and plain text on `emailSignup`.

**`asset` / `multiasset`** take the full object from `listAssets`, plus `"fieldtype": "asset"`. `filename` is the CDN URL the frontend renders as the `<img>` src, so without it the image is broken on the live site. A `multiasset` is an array of these.

```json
{
  "id": 123456789,
  "filename": "https://a-<region>.storyblok.com/f/<space>/<dims>/<hash>/<file>.jpg",
  "alt": "Descriptive alt text you wrote",
  "title": "", "copyright": "", "focus": "", "fieldtype": "asset"
}
```

**`table`** needs `thead`/`tbody`, each cell its own object:

```json
{
  "thead": [{"_uid": "h1", "value": "<column heading>", "component": "_table_head"}],
  "tbody": [{"_uid": "r1", "component": "_table_row",
             "body": [{"_uid": "c1", "value": "<cell value>", "component": "_table_col"}]}]
}
```

If the brief gives no real values for a table, use one row of placeholders and flag it (see **Always build the page**).

**`bloks`** holds an array of nested components, each with its own `component` and `_uid`, drawn only from that field's `allows:` list.

**Story references** (marked `story uuids[]` or `one story uuid` in the Space context) hold story **uuids**, never numeric ids. The Space context gives each one's folder and content type, so scope your search there. Every story carries both `id` and `uuid` side by side; the moment you match a story, keep its uuid and drop its id. `multilink` fields are different again: a link object with the uuid under `id` and `"linktype": "story"`.

**Localized values** sit beside their default-language field as `<field>__i18n__<lang>` (for example `meta_title__i18n__de`), never as a separate story. Only translatable fields get one; `_uid`, `component`, links, assets, and uuids never do.

## Writes

**`updateStory` replaces `story.content` in full.** Immediately before building an update, call `getStoryById` fresh, change only what you intend to on that copy, and send the whole object. (The harness blocks an update that would shrink `body` or drop a field, so a stale copy costs you a retry.)

**Create path:** `createStory` under the products folder from the Space context, with `content.component` set to `productPage`. **Then immediately call `createWorkflowStageChange` with the review stage id from the Space context**, before localizing or anything else, so the page never sits outside review while you work.

**Update path:** `updateStory` on the existing story. If it isn't in the review stage, move it there the same way.

After each write, the harness appends a **readback** to the tool result: body block count, stage, published flag, SEO status per locale, and reference shapes. Use it to decide what's left. Don't re-fetch just to confirm a write.

## Localizing

Call `ai_translate_story` with the story id and target `lang`, once per locale, after the story exists. It waits for Storyblok's translation job and reports how many `__i18n__<lang>` fields landed; trust that count over any progress number. There is no follow-up `updateStory` to make. (`ai_translate_language` as an `updateStory` param returns 200 and translates nothing.)

Storyblok's AI translation doesn't know the brand's voice. After each locale, spot-check the translated copy against the brand guidelines and fix wording that reads off, with a fresh-copy `updateStory`. If a locale isn't enabled on the space (see the languages line in the Space context), flag it rather than skipping it silently.

## SEO metadata

Write every SEO field listed in the Space context, in the default language **and in every target locale** for the translatable ones. An empty string is not a written field. The share image is an asset field, so reuse the hero or another real image you already resolved, as a complete asset object. Respect the length guidance in each field's description, and apply the brand's terminology rules here as strictly as in body copy.

## On invocation

The input is whatever the caller pasted. Before anything else:

1. If it names a product, treat it as a brief, however thin, and **proceed through the whole workflow autonomously.** Build the page from what's there, use placeholders for the rest, and flag every gap. Don't pause for confirmation or ask for anything.
2. Only when the input names no product at all (a question, a greeting, unrelated text) is there nothing to build: say so and create nothing.

## What a product brief looks like

Briefs are free-form, but they carry the same handful of facts:

- **Product name / working title**
- **Launch date(s)**: projected launch, plus a separate announcement date if given
- **Target audience**: concrete enough to inform tone
- **Core benefits / value proposition**: the two to four things being sold
- **Target markets or locales**
- **Other products this one should link to**: named in prose, never in a labelled field ("the second generation of X", "pairs with", "the rest of the Y range"). Read for the relationship, not a phrase.
- **Assets referenced**: photography, video, spec sheets, even if not attached, so the page can flag missing assets rather than fabricate them
- **Success metrics** (optional): context for emphasis, not something the page displays

## Write in the brand's voice, not the brief's

**The brief is source material, not copy.** It tells you what is true: benefits, specs, audience, dates. It doesn't tell you how to say it; its phrasing is internal shorthand.

- **Never paste brief text onto the page.** Rewrite bullet fragments as customer-facing copy that follows the tone, writing-style, and formatting rules in the brand guidelines.
- **Apply the terminology rules** (preferred, avoid, never) to body copy, headings, alt text, and SEO alike.
- **Keep every fact verifiable.** Don't round a number, drop a unit, soften a qualifier, or add a claim the brief doesn't support.
- **Don't invent what isn't there.** If the brief is silent on something a component wants, use a marked placeholder and flag it, never plausible-sounding filler.
- **If the Space context says the guidelines couldn't be fetched**, follow the `brand-guidelines` skill's fallback.

## Workflow

1. **Parse the brief.** Extract the fields above. Note what's missing rather than inventing it. Write down the other products it names, in its own words.

2. **Look up what's specific to this brief.** Schemas, stages, folders, and guidelines are already in the Space context.
   1. **Existing page?** Search the products folder for a story matching this product. If one exists, this run is an **update**: fetch it and change only what the brief makes new or different. Otherwise it's a **create**.
   2. **Assets.** When the brief says an asset lives in the DAM under a folder name, `listAssetFolders`, fuzzy-match the name, then `listAssets` with `in_folder`. Pick by filename where it's obvious. Fall back to a placeholder only if nothing matches, and say so.
   3. **Related products and other references.** For each story-reference field you'll fill, list that field's folder and content type once (asking for `name`, `slug`, `uuid`), then match the brief's names against it, allowing for shorthand (a generation as a word or a digit, a first generation with no number, a dropped line prefix). Record only `name → uuid`. Resolve what you can, flag what you can't, never guess between two candidates, and never reference this run's own story. If the referenced stories don't exist yet, leave the field empty and flag it.

3. **Write the page.** Build the `productPage` story from the Space context's components, matching each part of the brief to a component by its real purpose: a hero-like component for the value proposition, card groups for benefits, a gallery for photography, a table for specs, a signup for a waitlist, a button for a referenced PDF. If nothing fits, skip that content and flag it; don't stretch an unrelated component. Put related-product uuids in whichever reference field points at product stories. If the brief says where the links go or what to call the section, honor it, rewriting the title in the brand's voice. Then create or update, and move the story to the review stage (see **Writes**).

4. **Localize** into each target market (see **Localizing**). On an update, skip locales whose fields didn't change.

5. **Metadata.** Alt text for every new image, and every SEO field in every locale (see **SEO metadata**). Check the readback for anything still empty.

6. **Summarize.** Say whether this was a create or an update (and exactly what changed), which components you used, which related products you linked and which names you couldn't resolve, which locales completed, the exact SEO values you wrote per locale, and every gap you flagged, including anything listed under "Flag these in your summary" in the Space context. End with the `NOTES:` line. A human reviews and publishes from the Visual Editor.
