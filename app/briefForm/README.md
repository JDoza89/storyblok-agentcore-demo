# briefForm

A textbox. Marketers paste a brief, click a button, the agent runs.

One Lambda behind one Function URL serves the page *and* invokes the runtime —
no API Gateway, no static bucket, nothing to keep in sync. The URL is the whole
product; paste it into Slack and you're done.

| File | Purpose |
| --- | --- |
| `page.html` | The form. Textarea, passcode, live output. |
| `index.mjs` | `GET /` serves the page, `POST /run` invokes and streams back. |
| `deploy.sh` | Creates/updates the role, function and URL. Idempotent. |

## Deploy

```sh
BRIEF_FORM_PASSCODE='pick-something' ./deploy.sh
```

Prints the URL. Send that to coworkers, and the passcode separately.

Re-run it to ship a change to either file.

## Why streaming

A run takes ~10 minutes. A form that sits silent that long looks broken, so the
agent's own text deltas are piped through to the page as they arrive — the
marketer watches it work. That means the browser holds the connection open, and
**Lambda's 15-minute ceiling is the real timeout.**

If a run outlives it, the failure is soft: the skill creates the story and moves
it to `Reviewing` early, so the page still exists in Storyblok and is still safely
in review. What's lost is the tail of the transcript, not the work. The error text
on the page says as much.

If runs start landing past ~13 minutes, move the invoke to a Fargate task and have
the page poll — nothing else in the design changes.

## Security posture

The Function URL is `auth-type NONE`, so anyone with the link can reach the page.
The passcode (env var, checked server-side) is what actually gates a run. That is
deliberate — marketers can't sign SigV4 requests, so the alternative is no access
at all.

What this means in practice:

- **Every run writes to the production Storyblok space.** Nothing is ever
  published (the agent has no publish rights and the skill forbids it), but stories
  do get created and left in `Reviewing`.
- **Rotate the passcode** by re-running `deploy.sh` with a new value.
- **The IAM role can invoke exactly one runtime** and nothing else — see the
  inline policy in `deploy.sh`.
- The URL is unlisted, not secret. Treat it as public.

## Session isolation

Each submission gets a fresh `runtimeSessionId`, and the agent keys its per-session
cache on it (`main.ts`), so two marketers running briefs at the same time get
independent agents rather than one interleaved conversation.
