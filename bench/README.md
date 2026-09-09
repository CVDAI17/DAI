# Bench 

A personal command center you talk to. Board, numbers, morning brief, voice Q&A.

## Deploy

**1. Get an API key**

https://console.anthropic.com/settings/keys

Copy it now — it's shown once.

**2. Create the Pages project**

https://dash.cloudflare.com/

Workers & Pages → Create → Pages → Upload assets. Upload this whole folder,
including the `functions` directory.

Make this a **new project**, not part of any existing one, and give it a name
that isn't traceable to you — the name becomes the public URL. Don't attach a
custom domain. See "Keeping this separate" below.

**3. Add the key**

In the project: Settings → Environment variables → Add. Name it exactly
`ANTHROPIC_API_KEY`, paste the key, and set the type to **Secret** (not plaintext).
Add it to both Production and Preview.

**4. Redeploy**

Environment variables only take effect on the next build, so trigger a redeploy
after adding the key. If you skip this you'll get "Server is missing its API key."

**5. Install it**

Open the live URL on your phone. iOS: Share → Add to Home Screen. Android or
desktop Chrome: the install icon in the address bar.

The mic works properly once it's on a real HTTPS origin — that's the main reason
this is worth deploying rather than running from a file.

## How performance was handled

- **Two models.** Voice questions go to Sonnet 5, because when you're standing
  there waiting for it to speak, latency *is* quality. The morning brief goes to
  Opus 5, because nobody is waiting and the reasoning is the point. Both are set
  in `functions/api/chat.js` under `MODELS` — change them there.
- **Streaming.** Responses stream token by token, and speech starts on the first
  completed sentence instead of waiting for the whole answer. This is the single
  biggest difference in how fast it feels.
- **Prompt caching.** Your board is sent as a cached system prefix, so follow-up
  questions reuse it at a tenth of the input price and get a faster first token.
- **Short answers by design.** The voice prompt caps length and bans lists,
  headers and markdown, which don't read aloud.
- **App shell cached.** A service worker caches the page and script, so it opens
  instantly and works offline for everything except asking questions.
- **Voices warmed on load.** Picking a speech voice lazily costs about half a
  second on the first reply.
- **Hands-free.** Turn it on and the mic reopens the moment it stops speaking,
  so you can keep talking without touching anything. Tapping the mic turns it
  back off.
- **Web search.** It can look things up when the answer isn't on your board.
  The prompt tells it not to search when the board already has the answer,
  because a search costs a second or two of silence.

## Keeping this separate

This is private. Nothing here should point back at any of your public sites.

- **Deploy it as its own Pages project.** Don't add it to an existing project or
  upload it into one. A separate project gets its own `*.pages.dev` address,
  which has no registrar record and nothing tying it to a domain you own.
- **Never attach it as a subdomain of a public site.** The moment it becomes
  `something.yourdomain.com`, the DNS record is public and permanently links the
  two. If you want a custom domain, register a different one.
- **Pick a project name that gives nothing away.** The project name becomes the
  URL, so avoid your own name, your business name, or anything guessable from
  them.
- **It's set to noindex.** `robots.txt`, a meta tag and an `X-Robots-Tag` header
  all tell search engines to skip it, so it won't turn up in results for your
  name.
- **Referrers are off.** If you ever click a link out of this app, the
  destination won't see where you came from.
- **Lock it to you.** In the project: Settings → Access policy → enable
  Cloudflare Access and restrict to your email. One-time email code to get in,
  and it also closes the open API endpoint. This is the one worth doing.

Being in the same Cloudflare account is fine — that dashboard is private. It's
domains, links and search results that create a public connection, and none of
those apply here.

## Cost

Roughly a thousand tokens in and a few hundred out per exchange. At a handful of
questions and one brief a day this runs a few dollars a month. Watch it here:

https://console.anthropic.com/settings/usage

Set a spend limit while you're in there — worth doing on any key that sits on a
public URL.

## Notes

- Your board lives in the browser's local storage on that device. It isn't synced
  and it isn't on a server. Clearing site data wipes it.
- Speech recognition needs Chrome or Edge. Safari and Firefox don't support it
  properly. Speech *output* works everywhere.
- There's no wake word. A browser can't listen in the background, so it's
  tap-to-talk.
- The API endpoint is open to anyone who finds the URL. At your traffic that's a
  non-issue, but if you want it locked down, Cloudflare Access on the project is
  the simplest fix.
