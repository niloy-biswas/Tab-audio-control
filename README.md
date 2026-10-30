<p align="center">
  <img src="icons/icon128.png" width="80" alt="">
</p>

<h1 align="center">Tab Audio Control</h1>

<p align="center">
  A Chrome extension (Manifest V3) for setting volume and output device per tab, plus one gain control for your microphone.
</p>

<p align="center">
  <img src="docs/popup.png" width="340" alt="Popup listing three playing tabs: Facebook at 100% on MacBook Pro Speakers, a YouTube video at 55%, and a Messenger call at 40% routed to Bluetooth earbuds, with a microphone slider at the bottom">
</p>

## What it does

- **Per-tab volume.** Each tab that's playing sound appears in the popup with its own slider (0 to 100%). If the site has its own volume control, like YouTube's, the two stay in sync.
- **Per-tab output device.** You can send one tab to your headphones and another to the laptop speakers. In Chrome the device list only appears on sites that already have microphone permission, which call sites like Messenger or Meet usually do.
- **Mic gain.** One slider turns your microphone up or down on every site. It applies to mic streams that start after the extension loads.

Settings last for the browser session only. They survive Chrome putting the extension to sleep, but closing a tab, restarting the browser, or reloading the extension resets everything to 100% volume and the system default output.

## Install

No build step and no dependencies.

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and select this folder.
3. Pin the extension and click its icon while a tab is playing audio.

Tabs that were already open get the extension's scripts added automatically when it installs or reloads, so you don't need to refresh a call that's in progress.

## Using it

- Tabs show up in the popup while they're audible, and stay listed once you've changed their volume or output.
- The **Out** row under each tab shows what you can do on that site:
  - A device dropdown: pick an output.
  - "Allow mic on this site to list outputs": Chrome only lists output devices to sites with mic permission. Grant mic access on the site and reopen the popup.
  - "Refresh this tab to enable controls": the extension can't reach that tab. This happens on `chrome://` pages and the Web Store, where extensions aren't allowed to run.
  - "Grant on page…": only appears in browsers that support `selectAudioOutput()` (Firefox, currently). Clicking it shows a button on the page itself, which you then click to open the browser's device picker.

## Limitations

- Volume and output routing only reach `<audio>` and `<video>` elements in the page, including ones inside open shadow roots. Audio played through the Web Audio API, or through an audio element that's never added to the page, won't respond.
- Volume can't go above 100%. The browser caps `HTMLMediaElement.volume` at 1.
- Mic gain doesn't affect a mic stream that started before the extension loaded. Rejoin the call to pick it up.

## Files

| File | Role |
|---|---|
| `manifest.json` | Permissions and content script registration |
| `background.js` | Service worker. Holds per-tab state and relays messages between the popup and tabs |
| `content.js` | Runs in every frame. Finds media elements and applies volume and output device |
| `mic-gain-hook.js` | Runs in the page's own JS world. Wraps `getUserMedia` with a gain node |
| `popup.html` / `popup.js` | The popup UI |
| `icons/` | Extension icon. `icon.svg` is the source for 32/48/128, and `icon-16.svg` is a simpler version for the toolbar |
| `docs/` | Images used by this README |
| `PRIVACY.md` | Privacy policy, used as the Chrome Web Store privacy policy URL |
| `NEXT_BUILD.md` | Design notes for planned features |
