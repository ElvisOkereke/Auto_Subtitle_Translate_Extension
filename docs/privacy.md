# Privacy policy: Auto Subtitle Translator

> **Draft for review before publishing.** It describes what the code does
> today (November 2026). Fill in the bracketed parts, and have it checked
> before the store listing goes live.

Effective date: [date]. Contact: [contact email].

Auto Subtitle Translator translates video while you watch it. It is built so
that recognition happens on your own computer and only text leaves it, and
only to the translation service you choose.

## What stays on your computer

- **Video pictures and audio.** Reading subtitles from the picture (OCR) and
  recognising speech (Whisper) run inside your browser, on your graphics card
  or processor. Frames and audio are never uploaded.
- **Your settings, saved subtitle boxes, translated lines and glossaries.**
  Stored in the extension's own browser storage. Settings without secrets use
  Chrome's synced storage, so Chrome may copy them to your other devices if
  you have Chrome sync on.
- **API keys.** Stored only in this browser's local extension storage, never
  synced, and only ever sent to the service they belong to.

## What is sent, and to whom

- **Text to translate.** The subtitle or speech text the extension recognised,
  with up to two lines before and after it for context (DeepL and Claude), goes to the translation
  service you chose in Settings: Google Cloud Translation, DeepL, Anthropic
  (Claude), an Anthropic-compatible gateway you entered, or our hosted service
  if you subscribe. With Claude, the video's title, channel name and
  description are sent too, so names and topic-specific words are translated
  correctly. Each service handles this text under its own privacy policy.
- **Text selected with Screen Translate.** The text under the box you drag
  goes to the same translation service.
- **Model downloads.** The first time a mode is prepared, the speech and
  subtitle-reading models are downloaded from Hugging Face (huggingface.co),
  which sees an ordinary download request from your browser.

The extension has no analytics, no tracking and no advertising, and it does
not sell or share data.

## The hosted service (only if you sign in)

If you sign in to use translation without your own keys, our server stores:

- your email address (to sign you in with a one-time code), your plan and
  subscription status, and a Stripe customer ID (Stripe handles payment
  details; we never see card numbers);
- sign-in codes and session tokens, stored only as one-way hashes;
- monthly usage totals per account (cost, number of requests, characters),
  used to enforce plan limits;
- short-lived rate-limit records (to stop abuse of sign-in and translation).

Text sent for translation passes through the server to the translation
provider and is not stored or logged. Sign-in emails are sent through
[email provider]. You can delete your account by contacting [contact email].

## Permissions and why they are needed

| Permission | Why |
|---|---|
| Read and change data on websites | To find the video on the page, read subtitles from its picture, and show translations on it |
| Tab capture | Audio mode listens to the tab's sound to recognise speech (on your computer) |
| Offscreen document | Runs speech recognition in the background while you watch |
| Scripting | Adds the extension to tabs that were open before it was installed |
| Storage | Keeps your settings, keys and translated lines |

## Children

The extension is not directed at children under 13.

## Changes

If this policy changes, the new version will be published here with a new
effective date.
