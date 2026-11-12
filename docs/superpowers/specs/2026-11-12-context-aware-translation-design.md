# Context-aware translation (translation engine layer) — design

Piece 2 of 4 (1 subtitle mode — done; 2 this; 3 E2E alongside; 4 accounts,
subscription, hosted proxy). Spec date 2026-11-12.

## Intent

Subtitles should read the way a fan of the content would write them. In a
Korean League of Legends stream 뽀삐 is "Poppy", 렙차 is a level gap, 갱 is a
gank. The same holds for every kind of video the user watches with foreign
speech or burned-in subtitles: other games, sports broadcasts (player and team
names, commentary slang), anime and TV (character names, recurring terms),
movies. Word-by-word engines mangle exactly these words.

Measured today (docs/performance.md, 36 real League lines): DeepL with
neighbouring lines 65%, Claude Opus 5.5 with neighbouring lines 89%,
Sonnet 5.5 82%, Haiku 5.5 58%. End to end the shipped DeepL path scores 0.60
with the Claude judge and gets League terms right in 82% of lines.

What the user said:
- Translation must be context aware: proper names, game lingo, domain jargon.
- Not League-only: "as many use cases as possible" — sports, anime/TV, movies.
- Engine choice is a user-configurable setting.
- Translation quality and speed matter most; ToS and cost are not constraints.
- Training/distilling a cheaper model is welcome on the roadmap.

## Goals

1. **Context from the video itself, no user setup.** Each translation request
   carries what the video is about: page title, channel/uploader, description
   (YouTube: from the page; elsewhere: document title + meta description), the
   neighbouring lines, and the glossary (below). A short topic summary
   ("League of Legends, Korean solo-queue stream, champions Poppy, Pantheon")
   is inferred once per video by Claude from that metadata plus the first
   lines, and reused.
2. **Consistent names and terms (glossary).** Claude returns, with each
   translation, any names/terms it fixed (source → target). These accumulate
   per video and per topic, are sent with later requests, and persist in the
   extension origin (like timelines). The next video on the same topic starts
   with that topic's glossary. The user can view, correct and delete entries.
3. **Fast then best.** The fast engine (DeepL) puts a translation on screen
   immediately; Claude's context-aware translation replaces it. With
   read-ahead most lines get Claude's version before they appear, so the swap
   is rarely visible. The existing timeline `quality: 'fast' | 'better'`
   field and `setTranslation` ranking already model this.
4. **Engine choice is a user setting** (popup): *Fast then best* (default
   when an Anthropic key is set), *Fast only* (DeepL, or Google), *Best only*
   (wait for Claude). Claude model is a setting too: Opus 5.5 (default),
   Sonnet 5.5, Haiku 5.5.
5. **Both modes.** Subtitles mode and Audio mode captions use the same engine
   layer and context (audio mode's neighbouring lines = previous captions).
   Screen Translate keeps its single-shot path but may use the chosen engine.
6. **Engine abstraction ready for piece 4.** One interface for engines
   (DeepL, Google, Claude, later "hosted proxy"); the hosted proxy will accept
   the same request shape, so piece 4 swaps the transport, not the callers.
7. **Cost measured.** Tokens and cost per line (and per hour of video) per
   model, written to `docs/performance.md`; it feeds piece 4's pricing.

## Non-goals

- Distillation / fine-tuning an open-weight model. Planned as its own project
  after this piece, informed by the cost numbers measured here (Opus-generated
  translations as training data, LoRA fine-tune of a small open model, maybe
  run locally). Opus cannot edit another model's weights directly; distillation
  is the realistic form of that idea.
- Accounts, subscription, hosted proxy, Stripe (piece 4).
- DRM streaming services (Netflix, Crunchyroll, Disney+): their video frames
  read as black, so burned-in OCR can't work there; translating their own
  subtitle tracks is a separate later piece. Audio mode already works there.
- New languages beyond the nine subtitle languages and current targets.

## Anti-goals (failure even if it technically works)

- The same name translated two different ways in one video.
- Visible flicker: a line swapping repeatedly, or a swap to a translation that
  is not better.
- Any API key leaving the user's machine except to its own provider, or keys
  in logs / committed files / the extension bundle.
- A Claude outage or rate limit making subtitles disappear: DeepL keeps working.
- Quality regressions on League while generalising.

## Constraints

- Chrome MV3 extension. Claude is called from the service worker with the
  user's own Anthropic key (BYOK) — direct browser access to the Anthropic API
  (official TypeScript SDK with browser access enabled, or the equivalent
  header). Keys stored in `chrome.storage.local` (see decisions below).
- Models: `claude-opus-5-5` ($4 / $20 per MTok, cache reads $0.20; thinking
  can't be disabled — use low effort), `claude-sonnet-5-5` ($2 / $10),
  `claude-haiku-5-5` ($0.10 / $0.50). Measured latency with context: Opus
  ~2.2 s, Sonnet ~1.0 s, Haiku ~0.8 s.
- Live lines must never wait for Claude in *Fast then best*; the existing
  priority (live before read-ahead) applies to Claude requests too.
- E2E-first verification as in CLAUDE.md: mock Claude endpoint on the local
  fixture server via `devEndpointOverrides` (loopback only); real-Claude runs
  are opt-in and must not put credentials in the extension — the test server
  relays to the real API with credentials from the environment.

## Swap behaviour (my call)

Claude's version replaces DeepL's in place, without animation, only if the
line is still on screen or not yet shown (Claude never gets replaced by DeepL
— ranking already enforces this). If Claude returns the same text, nothing
changes.

## Claude access: direct key or gateway (user's decision: both)

The Claude settings accept either an Anthropic API key (direct to
`api.anthropic.com`) or an Anthropic-compatible gateway: base URL + token,
with the auth style selectable (`x-api-key` or `Authorization: Bearer`). My
calls for the gateway: HTTPS only; the extension asks for host permission for
that one origin at runtime (optional host permission) instead of a blanket
manifest permission; the token is only ever sent to the configured host; the
client always sets explicit prompt-cache breakpoints (some gateways require
them on long prompts, e.g. the Fuelix gateway used for this repo's benchmarks).
E2E covers both modes against the local mock.

## Decisions on the builder check (my calls)

- **Glossary before the first Claude line, re-translation after corrections.**
  The topic-summary step also returns a starting glossary from the metadata
  (title, description, first lines), so the first Claude batch already uses it.
  Terms learned later apply to every line not yet shown. When the user edits
  or deletes an entry, lines of this video containing that source term are
  re-translated (each line is stamped with the glossary version it used); a
  line already on screen swaps at most once per correction.
- **Keys move to `chrome.storage.local`** (Anthropic, DeepL, Google), with a
  one-time migration from `storage.sync` — sync uploads them to Google, which
  breaks the "keys only go to their own provider" anti-goal.
- **The engine interface is high level:** "translate these lines with this
  context and glossary" → translations + glossary updates. Prompt building,
  topic summaries, batching, caching and token metering sit behind it in a
  module written so it can also run on the server; in piece 4 the hosted
  proxy implements the same interface (and meters usage). DeepL and Google
  are engines behind the same interface.
- **Claude unavailable:** *Fast then best* and *Best only* require an
  Anthropic key; without one the popup offers *Fast only*. If Claude fails,
  the line falls back to DeepL/Google when a key exists; otherwise the
  original line stays untranslated and the popup shows the error. Choosing
  *Best only* without a fast-engine key is allowed.
- **Audio mode under Fast then best:** a caption already gone when Claude
  answers is not re-shown; Claude's version still enters the context for the
  following captions.

## Acceptance (measured, E2E)

- League stretch s1, real Claude Opus, default configuration: Claude judge
  score ≥ 0.80 (DeepL today: 0.60); key League terms right in ≥ 10/11 lines
  (DeepL: 9/11); every line still shown in time.
- With read-ahead, ≥ 90% of lines already have Claude's translation when they
  appear.
- Generality: a text benchmark of real subtitle lines from at least three
  non-gaming domains (e.g. football commentary, anime, a film), each with its
  page title/description as context, judged by Claude: context-aware Claude
  beats DeepL-with-context in every domain.
- Glossary: within one video, a name seen in several lines is translated the
  same way every time.
- Claude failing (mocked 429/500/timeout) leaves DeepL translations on screen.
- Cost per line and per hour of video reported per model.

## Left to the builder

- Prompt wording, the request/response format (structured output vs tagged
  text), and how glossary updates are returned.
- Batching several read-ahead lines per Claude request and prompt caching
  of the stable prefix (instructions + video context + glossary).
- Topic keying/normalisation for cross-video glossaries.
- Where the glossary editor lives (popup section or an options page).
- Choice and sourcing of the non-gaming benchmark lines (real subtitles, with
  reference translations).
