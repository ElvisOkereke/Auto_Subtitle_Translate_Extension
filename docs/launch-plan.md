# Launch plan

What stands between the extension as it is (November 2026) and everyday users
on the Chrome Web Store, then what comes after. Items marked **(you)** need
your accounts, money or a decision; everything else can be built and verified
in the repo.

## Where it stands

Built and verified by the automated suite (588 unit tests, 67 browser tests):

- Subtitles mode with read-ahead on YouTube, robust to loose or misplaced boxes
- Audio mode with read-ahead on YouTube, live captions elsewhere
- Screen Translate
- Fast-then-best translation (DeepL or Google, then Claude with video context
  and a glossary)
- First-run setup page that prepares the models ahead of use
- Debug panel with a copyable report
- Hosted subscription service (accounts, Stripe, metered proxy), built and
  tested locally, not deployed
- Store package: `npm run package`

## 1. Blockers for a public launch

### Translation must work without API keys (done for Chrome, 2026-11-19)

**Done:** Chrome's built-in translator is the free default (design:
`docs/superpowers/specs/2026-11-19-free-tier-design.md`). About 47% on the
Korean benchmark, level with Google and DeepL line by line; the setup page
downloads the language packs. Opera GX, Edge and Brave have no packs: their
users need a key or the subscription (decided: Chrome-only for now). Your
remaining steps: [launch-guide.md](launch-guide.md).

The options as they were weighed:

1. **Chrome's built-in translator as the default fast tier.** Chrome's
   on-device Translator API (stable on desktop since Chrome 138) translates
   with no key, no cost and nothing leaving the computer. Its language packs
   can be downloaded on the setup page alongside the other models. To build:
   a translation engine for it, an availability check, a setup-page step, and
   a quality run on the existing translation benchmark to confirm it beats
   "no translation" by a wide margin. Other Chromium browsers (Opera GX,
   Edge, Brave) may not have it: they keep the key or subscription options.
2. **Deploy the hosted service (you)** so "sign in and subscribe" works: the
   best tier (Claude) with no keys. Possibly a small free allowance as a
   trial.

### Deploy the hosted service (you)

The code and deploy script exist (`server/README.md`); what is missing is
accounts and secrets:

- a domain, and a Google Cloud project (the deploy script targets a Compute
  Engine VM with Caddy for HTTPS);
- Stripe in live mode with the Standard ($9.99) and Pro ($24.99) prices
  ([pricing.md](pricing.md));
- an email sender for sign-in codes (Resend, Postmark or similar);
- production Anthropic and DeepL keys with spending limits.

Then set `DEFAULT_SERVER_URL` in `src/settings.ts` and the account section
appears in the popup.

### Chrome Web Store listing (you)

- Developer account (one-time $5).
- Privacy policy at a public URL: [privacy.md](privacy.md) is a draft
  describing what the code does. Fill in the contact details, review it,
  and host it (GitHub Pages or the portfolio site).
- Permission justifications: the table in the privacy draft covers each one.
  Expect questions about "read and change data on all websites" and tab
  capture; the single purpose is "translate the video you are watching".
- Listing assets: screenshots at 1280×800 (the `docs` test project can
  render them), a 440×280 promo tile, a short and a long description.
- Name check: "Auto Subtitle Translator" is generic; search the store for
  clashes before committing to it.

### Decisions only you can make

| Decision | Options | Suggestion |
|---|---|---|
| License | MIT (open), source-available, or all rights reserved | Not MIT while the hosted tier is the business: "all rights reserved, source visible" keeps the portfolio value without giving the product away |
| Free experience | Built-in translator only, or also a small hosted allowance | Built-in translator for everyone, Claude as the paid upgrade |
| Browsers you support | Chrome only, or also Edge, Opera GX, Brave | Chrome first; Opera GX next, since you use it (needs a pass on WebGPU and tab capture there) |
| Brand | Keep the name, or pick a distinctive one | Decide before the listing; renaming after launch loses reviews |

## 2. Before or right after launch: everyday-user polish

- **Translation step on the setup page:** choose built-in, own keys, or
  subscription, instead of "see Settings".
- **Overlay readability:** the original subtitle shows through the 55% tint
  more than "faintly" (see `docs/images/subtitles-mode.webp`). Consider a
  stronger tint, or a Settings choice between "show the original faintly" and
  "hide the original".
- **Disk space:** the best speech model takes 1.6 GB. Show it on the setup
  page and add "Remove downloaded models" in Settings.
- **Model hosting:** models download from Hugging Face at pinned versions with
  checksums. For reliability at scale, mirror them to your own storage bucket.
- **Low-end computers:** measure Audio mode on an integrated GPU and on the
  CPU-only path; tell people what to expect on the setup page.
- **Error reports:** today the debug panel copies a report to the clipboard.
  An opt-in "send report" would make support possible without tracking.
- **Release routine:** version bump, changelog, `npm run package`, tag.

## 3. Planned features

From the design documents and the project overview, roughly by value:

1. **Automatic subtitle detection:** find where the subtitles are, so no box
   has to be drawn. The size learning and subtitle picker built for loose
   boxes are most of the groundwork.
2. **Audio accuracy on fast, overlapping speech:** Korean League casting still
   loses about half its words, and names are misheard. A promising cheap step:
   pass the video's glossary terms to Whisper as a prompt.
3. **Remaining subtitle misses:** fast-cut compilations, a match clock inside
   the subtitle box, two-line subtitles at 720p, stylised captions.
4. **Screen Translate as its own tool:** its own card in the popup, a
   right-click menu item and a keyboard shortcut.
5. **Read-ahead beyond YouTube** (Twitch VODs and other players that use Media
   Source; DRM-protected services like Netflix can't be read this way).
6. **A cheaper best tier:** distil an open-weight translation model from
   Claude's outputs (planned since the context-aware translation design).
7. **Smaller items:** per-language choice of fast provider, captions for more
   than one tab at a time.

## Suggested order

1. Built-in translator as the keyless default, plus the setup-page
   translation step (makes the extension useful to everyone).
2. License, name, privacy policy, store listing; submit for review.
3. Deploy the hosted service; turn on subscriptions.
4. Everyday-user polish from section 2, guided by what early users report.
5. Automatic subtitle detection, then audio accuracy.
