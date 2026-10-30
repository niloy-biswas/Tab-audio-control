# Privacy Policy for Tab Audio Control

Effective date: October 31, 2026

Tab Audio Control is a Chrome extension for setting volume and output device per tab and adjusting your microphone level. It runs entirely inside your browser. It has no servers, no accounts, no analytics, and makes no network requests of its own.

## What the extension handles

| Data | Why | Where it goes |
|---|---|---|
| Volume, output device choice, and mic level you set | To apply your settings to each tab | Kept in Chrome's session storage on your device |
| Which tabs are currently using your microphone | To list those tabs in the popup | Session storage on your device |
| Names and IDs of your audio output devices (e.g. "MacBook Pro Speakers") | To show the device dropdown | Session storage on your device |
| Tab titles, addresses, and icons | To label each tab in the popup | Read when the popup opens, never stored |
| Microphone audio | To apply the mic level you set | Processed in the page as it plays, never stored |

Session storage is cleared when you close the browser or reload the extension. Nothing is written to permanent storage and nothing is synced to your Google account.

## Microphone audio

When a website starts using your microphone, the extension routes that audio through a volume control (a Web Audio gain node) inside the same page, then hands the adjusted audio back to the website. The extension does not record, save, analyze, or send your audio anywhere. The website receives your microphone audio just as it would without the extension, only louder or quieter.

The extension never turns on your microphone by itself. It only adjusts audio after a website has asked for and received your permission.

## What the extension does not do

- It does not collect, sell, or share any personal data.
- It does not send data to the developer or any third party.
- It does not track browsing history. Tab addresses are read only to label tabs in the popup.
- It does not load or run code from outside the extension package.

The popup shows each tab's icon. Chrome loads that icon from the tab's own website, the same way it does in your tab strip.

## Permissions

| Permission | Why it's needed |
|---|---|
| `tabs` | Find tabs that are playing audio and show their titles and icons in the popup |
| `scripting` and access to all sites | Apply volume, output device, and mic level on any site you use, including tabs already open when the extension is installed |
| `storage` | Keep your settings for the current browser session |

## Chrome Web Store User Data Policy

The use of information received through Chrome extension APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements.

## Changes

If this policy changes, the updated version will be posted here with a new effective date.

## Contact

Questions or concerns: open an issue at [github.com/niloy-biswas/Tab-audio-control/issues](https://github.com/niloy-biswas/Tab-audio-control/issues).
