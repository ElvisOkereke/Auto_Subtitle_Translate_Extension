# UI redesign — popup and on-page panels

Spec date 2026-11-12. The user asked for a UI whose controls match the real
features, light and dark mode, intuitive and user-friendly, with exceptional
design — and skipped the design questions. Every choice below is mine.

## Subject, audience, job

Someone halfway through a foreign-language video (a Korean League stream, an
anime episode, a football match) who opens the popup to get it translated. The
popup's primary job: **start translating what's on screen in two seconds**;
setup (keys, engine, account, glossary) is secondary and done once.

## What's wrong today (feature ↔ UI mismatches)

1. Audio mode's button says "Start Subtitles", but that mode makes live captions
   from speech; "Subtitles" is the other mode.
2. "Source language" applies only to audio captions, yet sits with global settings;
   subtitle mode has its own language.
3. Caption position and font size apply only to audio captions but look global.
4. "Subscription" appears in two dropdowns (fast provider and Claude access) though
   it is one choice: translate with my subscription, or with my own keys.
5. One long scroll mixes the everyday actions with one-time setup; a generic
   "Ready to start subtitles" banner says nothing about the actual state.
6. No dark mode; hard-coded colours; emoji logo; inline button colours.

## Design

**Signature element — the caption bar.** The popup's status line is drawn exactly
like the product's on-video subtitle (style C: dark see-through bar, bold
subtitle-yellow text) and speaks the current state as a subtitle line: "Draw a box
around the subtitles", "Translating Korean subtitles into English", "Live
captions on — speak and they appear". It stays dark in light mode, because it is a
subtitle. Primary actions reuse the motif (ink button with yellow text in light
mode, yellow button with ink text in dark mode). Everything else is quiet.

**Colour tokens** (`:root`, `[data-theme]`, `prefers-color-scheme`):

| Token | Light | Dark |
|---|---|---|
| `--bg` page | `#F3F4F7` cool fog | `#181B22` blue charcoal |
| `--surface` fields, menus | `#FFFFFF` | `#20242D` |
| `--ink` text | `#171A21` | `#ECEEF2` |
| `--muted` secondary text | `#5E6573` | `#A3AAB8` |
| `--line` dividers, borders | `#DFE3EA` | `#2E3440` |
| `--caption-bg` / `--caption-text` | `rgba(16,18,24,.92)` / `#FFD23F` | same |
| `--primary-bg` / `--primary-text` | `#171A21` / `#FFD23F` | `#FFD23F` / `#171A21` |
| `--good` / `--bad` | `#1E8E5A` / `#C23A3A` | `#4CC38A` / `#F07171` |

**Type:** Atkinson Hyperlegible (designed for legibility — fitting for a subtitle
tool), bundled with the extension (no network). Scale 12 / 13 / 15 / 18 px,
weights 400 and 700, sentence case everywhere, no all-caps labels.

**Layout (360 px):**

```
┌──────────────────────────────────┐
│ ▣ Subtitle Translator        ⚙   │  name; settings button
│ ┃ Draw a box around the subtitles ┃│  caption bar (state)
│ [ Subtitles ][ Audio ]            │  mode switch
│ Subtitles in  [Korean ▾]          │
│ Translate into [English ▾]        │
│ [▮ Draw subtitle box ▮]  (primary)│
│ Use saved box   Stop              │
│ ───────────────────────────────── │
│ Text on this page   [Translate…]  │  Screen Translate
│ ───────────────────────────────── │
│ Engine  Fast then best (Opus)  ›  │  summary rows → settings
│ Account Standard  $1.20 of $6  ›  │  (only when the service exists)
└──────────────────────────────────┘
Settings view (replaces the main view; back button):
  Translation — "Translate with": [My subscription | My own keys]
      own keys: fast engine + key, Claude access + key/gateway; engine mode; model
  Account — sign in / plan / usage / subscribe / manage / sign out
  Live captions — speech language, position, size
  Glossary for this video
  Appearance — theme: System / Light / Dark
```

Left-aligned throughout; one column; rows with label left, control right where
the control is short. Sections are separated by whitespace and a hairline, not
boxed into identical cards. Radius by role: caption bar 6 px (like a subtitle),
fields 8 px, buttons 10 px.

**Motion:** only in answer to an action — the settings view slides in/out
(120 ms), disabled under `prefers-reduced-motion`.

**Copy:** plain verbs, sentence case: "Start live captions" / "Stop live
captions", "Draw subtitle box" / "Redraw box", "Use saved box", "Translate text
on this page" / "Stop", errors that say what to do.

**On-page panels** (Screen Translate result, caption notices, box selection hint)
use the same tokens and follow the theme setting (System follows the OS).
The subtitle overlay (style C) and the live-caption lines stay as they are: they
are the product's output, designed for legibility over video in any theme.

## Acceptance

- Theme setting System/Light/Dark persists and applies to the popup and on-page
  panels; System follows `prefers-color-scheme`.
- Every control maps to a working feature; the mismatches above are gone
  (one "Translate with" choice; caption settings under Live captions; speech
  language only there).
- Keyboard: every control reachable, visible focus ring; contrast ≥ 4.5:1 for text
  in both themes.
- Screenshots of the popup (main + settings) and the Screen Translate panel in
  both themes reviewed; all existing behaviour tests pass (selectors kept; tests
  updated only for renamed labels and settings moving into the settings view).
