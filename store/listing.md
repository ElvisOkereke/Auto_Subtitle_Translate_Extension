# Chrome Web Store listing (paste-ready)

Everything the developer dashboard asks for, in the order it asks. Images are
in this folder; the package comes from `npm run package`.

## Package

`release/auto-subtitle-translator-<version>.zip` (`npm run package`).

## Store listing tab

**Name** (comes from `manifest.json`): Auto Subtitle Translator

**Summary** (from the manifest, 120 of 132 characters):
> Translate videos as you watch: subtitles burned into the picture, or what people say. Recognition runs on your computer.

**Description:**

> Watch videos in any language as if they had been subtitled for you.
>
> SUBTITLES IN THE PICTURE
> Many videos have subtitles burned into the image: Korean game streams, Spanish football, anime, TV dramas. Browser translators can't see them. Draw a box around where the subtitles appear (a rough box is fine) and the translation appears right over the original line as the video plays. On YouTube most lines are translated before they even appear.
>
> SPEECH IN THE TAB
> No subtitles at all? Audio mode listens to the tab and shows translated captions on the video as people speak. On YouTube each caption appears as its words are spoken.
>
> FREE, AND PRIVATE
> In Google Chrome, translation is free: it uses Chrome's built-in translator, on your computer. Reading the subtitles and recognising speech also run on your computer, on your graphics card when there is one. Video and audio never leave your computer.
>
> BETTER TRANSLATIONS WHEN YOU WANT THEM
> Add your own DeepL or Google key for faster, sharper translations, and Claude for translations that know what the video is about and keep names and game terms consistent.
>
> GETTING STARTED
> After installing, a setup page downloads what the extension needs once, so captions start in seconds when you want them. Then open a video, click the extension's icon and pick Subtitles or Audio.
>
> Also included: Screen Translate (drag a box over text on any page), a per-video glossary you can correct, light and dark themes, and an on-page debug panel for troubleshooting.

**Category:** Accessibility (alternative: Tools)

**Language:** English

**Graphic assets:**
| Asset | File |
|---|---|
| Store icon (128×128) | `icons/icon128.png` |
| Screenshots (1280×800) | `store/screenshot-1-subtitles.png`, `store/screenshot-2-setup.png`, `store/screenshot-3-modes.png` |
| Small promo tile (440×280) | `store/promo-440x280.png` |

**Official URL / Homepage:** https://github.com/ElvisOkereke/Auto_Subtitle_Translate_Extension
**Support URL:** https://github.com/ElvisOkereke/Auto_Subtitle_Translate_Extension/issues

## Privacy practices tab

**Single purpose:**
> Translates the video the user is watching: subtitles burned into the picture, and speech in the tab.

**Permission justifications:**

| Permission | Justification |
|---|---|
| `tabCapture` | Audio mode captures the current tab's sound so speech can be recognised (on the user's computer) and shown as translated captions. Only after the user starts Audio mode in that tab. |
| `offscreen` | Speech recognition and Chrome's built-in translator run in an offscreen document: the service worker can capture neither audio nor use the Translator API. |
| `storage` | Saves the user's settings, the subtitle box drawn for each video, translated lines and the glossary, and API keys the user enters (local only). |
| `scripting` | Adds the extension's scripts to tabs that were already open when it was installed, so the user doesn't have to reload them. |
| `activeTab` | Acts on the tab the user opened the popup in (start a mode, Screen Translate). |
| Host permission `<all_urls>` and content scripts | Videos with burned-in subtitles are on many sites. The content scripts find the video, read its frames for the subtitle box the user drew, and draw the translation on top. On YouTube a script reads the video the player has already buffered so lines can be translated before they appear. |

**Are you using remote code?** No. All code ships in the package. The
extension downloads machine-learning model weights (data, not code) from
Hugging Face at pinned versions with checksums.

**Data usage** (tick these):
- *Website content*: the subtitle or speech text recognised on the page is
  sent to the translation service the user chooses (DeepL, Google, Anthropic or
  the extension's hosted service). With Chrome's built-in translator nothing is
  sent.
- *Personally identifiable information*: only if the user signs in to the
  hosted service (email address). Not applicable while the hosted service is
  not launched.

Certify: not sold to third parties; not used or transferred for purposes
unrelated to the item's single purpose; not used for creditworthiness or
lending.

**Privacy policy URL:** where you publish `docs/privacy.md` (see
`docs/launch-guide.md`).

## Distribution tab

Visibility: **Unlisted** for a first round with friends (anyone with the link
can install), then **Public**. Regions: all.
