# AGENTS.md

Context for coding agents working on this repo. Read README.md first for what the extension does.

## Project shape

- Chrome MV3 extension, plain JS, no build step, no dependencies, no tests, no linter config.
- Syntax check: `for f in *.js; do node --check "$f"; done`.
- Real verification means loading it unpacked in Chrome (see "Testing" below). There is no automated way to exercise audio here.

## Architecture

Three execution contexts, all talking through messages:

```
popup.js ──runtime.sendMessage──> background.js ──tabs.sendMessage──> content.js (isolated world, every frame)
                                       ^                                   │ window.postMessage ({__tac: true})
                                       └────────runtime.sendMessage────────┤
                                                                           v
                                                               mic-gain-hook.js (MAIN world)
```

- **background.js** owns all state in `Map`s keyed by tabId (`tabVolumes`, `tabSinks`, `tabSinkDevices`, `micActiveTabs`) plus a global `micGain`. MV3 stops the worker after ~30s idle, so every mutation calls `persist()` to snapshot state into `chrome.storage.session`, and `ready` restores it when the worker starts. Every message waits on `ready`. `storage.session` clears on browser close and extension reload, so tabs still start at defaults across sessions, as the user wants. Don't move to `storage.local`. Entries are cleared in `tabs.onRemoved`.
- **content.js** discovers `<audio>/<video>` (walks open shadow roots, MutationObserver plus a 1s rescan) and funnels every element through `apply(el)`, which sets `.volume` and calls `setSinkId`. Any new per-element behavior belongs in `apply()`.
- **mic-gain-hook.js** must run in the MAIN world to monkey-patch `navigator.mediaDevices.getUserMedia`. It has no `chrome.*` access, so content.js bridges messages to it with `window.postMessage`.
- Device enumeration and the on-page picker run in the top frame only. Sub-frames return `false` for `REQUEST_DEVICE_LIST` / `SHOW_SINK_PICKER` so only one response reaches background.

### Message types

| Type | From → To | Notes |
|---|---|---|
| `CONTENT_READY` | content → bg | Reply seeds volume, micGain, sinkId |
| `POPUP_GET_VOLUME` / `POPUP_SET_VOLUME` / `GET_ALL_VOLUMES` | popup → bg | bg relays `SET_VOLUME` to the tab |
| `VOLUME_DRIFTED` | content → bg | Page changed volume itself; bg adopts it |
| `POPUP_GET_MIC_GAIN` / `POPUP_SET_MIC_GAIN` / `GET_ALL_MIC_STATE` | popup → bg | bg broadcasts `SET_MIC_GAIN` to all tabs |
| `MIC_CAPTURE_STARTED` / `MIC_CAPTURE_STOPPED` | hook → content → bg | Tracks which tabs have a live mic |
| `POPUP_GET_DEVICES` | popup → bg → content (`REQUEST_DEVICE_LIST`) | Fallback reply has `reachable: false` if the tab didn't answer |
| `POPUP_SET_SINK_ID` / `GET_ALL_SINKS` | popup → bg | bg relays `SET_SINK_ID` |
| `POPUP_REQUEST_GRANT` | popup → bg → content (`SHOW_SINK_PICKER`) | Shows on-page button for `selectAudioOutput()` |
| `SINK_DEVICES_UPDATED` / `SINK_DEVICE_UNAVAILABLE` | content → bg | Device list changed / routed device vanished |

## Gotchas (each one cost a debugging round)

1. **Content scripts don't load into tabs that were already open.** Manifest content scripts only reach tabs loaded after install/reload. `background.js` re-injects both scripts into open http(s) tabs in `runtime.onInstalled`. When this was missing, the popup still listed the tab (because `tab.audible`), but every slider and button silently did nothing.
2. **Re-injection means a tab can run the script twice.** `content.js` checks `window.__tacContentAlive?.()` and bails if a live instance exists. An orphan from before a reload has a dead `chrome.runtime.id`, so it calls `teardown()` on its next scan. Without teardown, the orphan resets `setSinkId("")` every second and fights the new instance. `mic-gain-hook.js` guards with `window.__tacMicHook`, otherwise gain gets applied twice.
3. **Chrome has no `selectAudioOutput()`** (Firefox only, per caniuse as of Oct 2026). In Chrome, labelled `audiooutput` devices from `enumerateDevices()` appear once the origin has mic permission, and `setSinkId` then works. The popup checks `granted && devices.length` before `supported` for this reason. Don't reorder it.
4. **Device IDs are origin-scoped.** A cross-origin iframe can't resolve the top frame's sinkId. Only a top-frame `NotFoundError` resets the tab to default (see `applySink`).
5. **`chrome.runtime.sendMessage` can throw synchronously** once the context is invalidated. Use `notifyBackground()` in content.js, never a bare call.
6. **Volume sync is two-way, but only for user-driven changes.** The `volumechange` listener adopts a page-side volume change only if the user touched the page in the last 1s (or is holding the pointer down, for slider drags). Otherwise the change came from page code, e.g. Messenger setting a new participant's `<audio>` to 1, and gets reverted. Reverts are capped at 5/sec per element so a page that re-asserts its volume can't loop with us. Before this, call audio jumped back to 100% mid-call.
7. **The popup skips re-rendering when the set of tabs is unchanged** (`loadTabs`), so a slider drag isn't interrupted. If you add per-row live state, update it in place rather than relying on a re-render.

## Known gaps / candidate work

- Audio routed through Web Audio (`AudioContext.destination`) or detached `new Audio()` elements isn't controlled. The fix would be a MAIN-world hook (patch `HTMLMediaElement.prototype.play` to track detached elements, wrap connections to `destination` with a GainNode). Only build it if a real site needs it. Messenger calls work without it.
- `manifest.json` description says "including boost above 100%", but the slider caps at 100% because `el.volume` max is 1. Boosting needs a Web Audio gain stage. Either build that or fix the description.
- `NEXT_BUILD.md`: the "Per-tab output device routing" section is **already shipped** (keep it for rationale or delete it). The "Global microphone input device selection" section is the next planned feature and is not started.

## Testing

1. `chrome://extensions` → reload the unpacked extension. Don't refresh test tabs; re-injection should cover them (that's part of what you're testing).
2. Have a YouTube tab and a call tab (Messenger/Meet) open at once.
3. Confirm each tab's slider changes only that tab's volume, and that YouTube's own slider and the popup stay in sync.
4. In the call tab (has mic permission), confirm the Out dropdown lists devices and routing a tab to a different output works.
5. Change mic gain, then start a new call and confirm the other side hears the difference.

## Icons

`icons/icon.svg` is the source for the 32/48/128 PNGs. `icons/icon-16.svg` is a separate, simplified design for the toolbar (no padding, faint tracks, or shadows, which blur at 16px). Nothing here can rasterize SVG (no rsvg/ImageMagick/cairosvg), so regenerate the PNGs with headless Chrome and `sips`:

```sh
cd icons && C="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" && T=$(mktemp -d)
for s in icon icon-16; do "$C" --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 --user-data-dir="$T/p" --window-size=512,512 \
  --screenshot="$T/$s.png" "file://$PWD/$s.svg"; done
sips -z 16 16 "$T/icon-16.png" --out icon16.png
for n in 32 48 128; do sips -z $n $n "$T/icon.png" --out icon$n.png; done
```

## Conventions

- Match existing style: 2-space indent, double quotes, trailing commas, comments explain *why* (often citing the bug that motivated the code).
- Reuse `buildSlider` / `buildHint` in popup.js and `apply()` / `collectMedia()` in content.js rather than adding parallel helpers.
- Keep state in `storage.session` only (no cross-session persistence) unless the user asks. Any new state must be added to both `persist()` and the `ready` restore, or it will silently reset when the worker restarts.
- Don't commit or push unless the user asks. Commit style: Conventional Commits (`feat:`, `docs:`, `fix:`).
