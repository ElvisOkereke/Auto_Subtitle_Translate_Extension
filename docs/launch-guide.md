# Launch guide: what's left for you to do

Everything that can be done in the repo is done: the free tier, the store
package, the listing text and images, a draft privacy policy, and a deployable
hosted service. What's left needs your accounts, your money or your decisions.
Do part 1 now; part 2 (subscriptions) can wait until after launch.

## Part 1: Chrome Web Store (about an hour of your time, then review)

You can launch without the hosted service: in Chrome, translation is free out
of the box, and anyone can add their own DeepL, Google or Claude keys.

1. **Decide the name and license.**
   - Name: the store shows `manifest.json`'s "Auto Subtitle Translator"; the
     popup and setup page say "Subtitle Translator". Pick one (search the store
     for clashes first) and tell me; I'll make everything match.
   - License: the repo is public with no license file. Tell me which (my
     suggestion: "all rights reserved, source visible", since the hosted tier
     is the business) and I'll add it.
2. **Finish the privacy policy.** Open `docs/privacy.md`, fill in the
   effective date, a contact email you're happy to publish, and the email
   provider (only needed once the hosted service exists). Remove the "Draft"
   note at the top.
3. **Publish the privacy policy at a public URL.** Simplest: once it's
   committed, use the GitHub link
   `https://github.com/ElvisOkereke/Auto_Subtitle_Translate_Extension/blob/main/docs/privacy.md`.
   (Or ask me to set up a GitHub Pages page for it.)
4. **Create a developer account:** https://chrome.google.com/webstore/devconsole,
   sign in with the Google account you want as publisher, pay the one-time
   $5 fee, verify the contact email. If you'll charge EU users (the
   subscription), you'll be asked to declare yourself a trader.
5. **Build the package:** `npm run package` → upload
   `release/auto-subtitle-translator-1.0.0.zip` with **New item**.
6. **Fill in the tabs** from [store/listing.md](../store/listing.md): store
   listing (description, category, images from `store/` and
   `icons/icon128.png`), privacy practices (single purpose, permission
   justifications, remote code: No, data usage, privacy policy URL),
   distribution (Unlisted first).
7. **Submit for review.** Expect a few days to a few weeks: tab capture and
   access to all sites get a closer look. If they ask questions, paste me the
   message and I'll draft the answer.
8. **Test the published version** (Unlisted link) in a fresh Chrome profile,
   share it with a few people, then switch to Public.

Updates later: bump `version` in `manifest.json`, `npm run package`, upload
the new zip in the dashboard.

## Part 2: Subscriptions (the hosted service), when you want income

Needed only for "sign in and subscribe" (Claude quality without keys). The
code, tests and deploy script exist; the checklist with exact commands is in
[server/README.md](../server/README.md#deploy-google-compute-engine-vm--checklist).
What you need to sign up for:

| Account | Why | Rough cost |
|---|---|---|
| A domain (e.g. Cloudflare, Namecheap) | the service's HTTPS address | ~$12 / year |
| Google Cloud project with billing | one small VM (e2-small) + Secret Manager | ~$15 / month |
| Stripe | subscriptions ($9.99 Standard, $24.99 Pro) | 2.9% + 30¢ per charge |
| Resend (or similar) | sign-in code emails | free up to 3,000 / month |
| Anthropic API | Claude translations | ~$3.40 per hour of video (Opus) |
| DeepL API Pro | fast tier for subscribers | $5.49 / month + $25 per million characters |

Then: run Stripe in test mode first, `server/deploy/gce.sh`, point the domain
at the VM, and tell me the domain: I'll set `DEFAULT_SERVER_URL`, rebuild, run
the end-to-end checks against it, and you upload the new package.

## What I can do next, on your word

- Rename to your chosen name everywhere; add the license.
- A GitHub Pages page for the privacy policy.
- Recapture the store screenshots after the rename.
- Draft answers to store reviewers.
- Help with the hosted deployment once you have the accounts (I can't create
  accounts or enter payment details for you).
