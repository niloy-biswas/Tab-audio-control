# AGENTS.md

Context for coding agents working on this repo. Read README.md first for what the extension does.

## Project shape

- Chrome MV3 extension, plain JS, no build step, no dependencies, no linter config.
- Syntax check: `for f in *.js; do node --check "$f"; done`.
- Mock tests: `for t in tests/*-test.js; do node "$t" || exit 1; done`. Each file loads one source file into a fake `chrome`/DOM and asserts the message flow; pass a path (`node tests/bg-test.js /tmp/copy.js`) to run it against a modified copy and confirm a test can fail. No test framework, just Node's `assert`. When you fix a bug, add a case that fails without the fix.
- Real verification still means loading it unpacked in Chrome (see "Testing" below). The mocks can't exercise actual audio, devices, permissions, or fullscreen.

## Architecture

Four execution contexts, all talking through messages:

```
popup.js ──runtime.sendMessage──> background.js ──tabs.sendMessage──> content.js (isolated world, every frame)
                                   │ ^ ^                                   │ window.postMessage ({__tac: true})
                       OFFSCREEN_* │ │ └────────runtime.sendMessage────────┤
                                   v │ ROUTE_*                             v
                              offscreen.js                     mic-gain-hook.js (MAIN world)
```

- **background.js** owns all state in `Map`s keyed by tabId (`tabVolumes`, `tabSinks`, `tabSinkDevices`, `micActiveTabs`, `tabRouted`) plus a global `micGain`. MV3 stops the worker after ~30s idle, so every mutation calls `persist()` to snapshot state into `chrome.storage.session`, and `ready` restores it when the worker starts. Every message waits on `ready`. `storage.session` clears on browser close and extension reload, so tabs still start at defaults across sessions, as the user wants. Don't move to `storage.local`. Entries are cleared in `tabs.onRemoved`.
- **content.js** discovers `<audio>/<video>` (walks open shadow roots, MutationObserver plus a 1s rescan) and funnels every element through `apply(el)`, which sets `.volume` and calls `setSinkId`. Any new per-element behavior belongs in `apply()`. While the tab is routed, the `routed` flag makes `apply()` leave element volume to the page (`setRouted` sets it to 1 once) and use sink `""`, and the `volumechange` listener does nothing.
- **Routing (opt-in, per tab).** "Route this tab" in the popup makes background call `tabCapture.getMediaStreamId`, create **offscreen.html** (reason `USER_MEDIA`, which has no idle timeout), and send it `OFFSCREEN_START`. `offscreen.js` plays the capture through `MediaStreamSource → GainNode → destination`, one `AudioContext` per tab so each can `setSinkId`. Background then sends `POPUP_SET_VOLUME` / `POPUP_SET_SINK_ID` / `POPUP_GET_DEVICES` for that tab to the offscreen document instead of content.js. The offscreen document and its captures survive a worker restart, so the restored `tabRouted` stays accurate. Routed sink IDs come from the extension's origin and live in `tabRouted`, separate from the site-origin `tabSinks`, which applies again on unroute.
- **setup.html** asks for mic permission once for the extension's origin and stops the stream. That grant is what lets the offscreen document list labelled outputs. The popup and offscreen document can't show permission prompts. It reuses `popup.css`.
- **mic-gain-hook.js** must run in the MAIN world to monkey-patch `navigator.mediaDevices.getUserMedia`. It has no `chrome.*` access, so content.js bridges messages to it with `window.postMessage`.
- Device enumeration and the on-page picker run in the top frame only. Sub-frames return `false` for `REQUEST_DEVICE_LIST` / `SHOW_SINK_PICKER` so only one response reaches background.

### Message types

| Type | From → To | Notes |
|---|---|---|
| `CONTENT_READY` | content → bg | Reply seeds volume, micGain, sinkId, routed |
| `POPUP_SET_VOLUME` / `GET_ALL_VOLUMES` | popup → bg | bg relays `SET_VOLUME` to the tab, or `OFFSCREEN_SET_GAIN` if routed |
| `VOLUME_DRIFTED` | content → bg | Page changed volume itself; bg adopts it |
| `POPUP_GET_MIC_GAIN` / `POPUP_SET_MIC_GAIN` / `GET_ALL_MIC_STATE` | popup → bg | bg broadcasts `SET_MIC_GAIN` to all tabs |
| `MIC_CAPTURE_STARTED` / `MIC_CAPTURE_STOPPED` | hook → content → bg | Tracks which tabs have a live mic |
| `POPUP_GET_DEVICES` | popup → bg → content (`REQUEST_DEVICE_LIST`) | Fallback reply has `reachable: false` if the tab didn't answer. Routed tabs ask offscreen (`OFFSCREEN_GET_DEVICES`) |
| `POPUP_SET_SINK_ID` / `GET_ALL_SINKS` | popup → bg | bg relays `SET_SINK_ID`, or `OFFSCREEN_SET_SINK` if routed |
| `POPUP_REQUEST_GRANT` | popup → bg → content (`SHOW_SINK_PICKER`) | Shows on-page button for `selectAudioOutput()` |
| `SINK_DEVICES_UPDATED` / `SINK_DEVICE_UNAVAILABLE` | content → bg | Device list changed / chosen in-page device vanished |
| `POPUP_ROUTE_TAB` | popup → bg | Capture, `OFFSCREEN_START`, then `SET_ROUTED {routed: true}` to the tab. Replies `{ok, error}` so the popup can show why it failed |
| `POPUP_UNROUTE_TAB` | popup → bg | `OFFSCREEN_STOP`, then `SET_VOLUME` (clamped to 1) and `SET_ROUTED {routed: false}` |
| `GET_ALL_ROUTES` | popup → bg | `{tabId: {sinkId}}` for routed tabs |
| `SET_ROUTED` | bg → content | Toggles the `routed` flag and re-applies |
| `OFFSCREEN_START` / `OFFSCREEN_SET_GAIN` / `OFFSCREEN_SET_SINK` / `OFFSCREEN_STOP` / `OFFSCREEN_GET_DEVICES` | bg → offscreen | Only `START` and `GET_DEVICES` reply |
| `ROUTE_ENDED` / `ROUTE_SINK_UNAVAILABLE` | offscreen → bg | Captured track ended (tab closed or navigated) / routed device vanished. Carry `tabId` in the message, since the offscreen document has no tab |

## Gotchas (each one cost a debugging round)

1. **Content scripts don't load into tabs that were already open.** Manifest content scripts only reach tabs loaded after install/reload. `background.js` re-injects both scripts into open http(s) tabs in `runtime.onInstalled`. When this was missing, the popup still listed the tab (because `tab.audible`), but every slider and button silently did nothing.
2. **Re-injection means a tab can run the script twice.** `content.js` checks `window.__tacContentAlive?.()` and bails if a live instance exists. An orphan from before a reload has a dead `chrome.runtime.id`, so it calls `teardown()` on its next scan. Without teardown, the orphan resets `setSinkId("")` every second and fights the new instance. `mic-gain-hook.js` guards with `window.__tacMicHook`, otherwise gain gets applied twice.
3. **Chrome has no `selectAudioOutput()`** (Firefox only, per caniuse as of Oct 2026). In Chrome, labelled `audiooutput` devices from `enumerateDevices()` appear once the origin has mic permission, and `setSinkId` then works. The popup checks `granted && devices.length` before `supported` for this reason. Don't reorder it.
4. **Device IDs are origin-scoped.** A cross-origin iframe can't resolve the top frame's sinkId. Only a top-frame `NotFoundError` resets the tab to default (see `applySink`).
5. **`chrome.runtime.sendMessage` can throw synchronously** once the context is invalidated. Use `notifyBackground()` in content.js, never a bare call.
6. **Volume sync is two-way, but only for user-driven changes.** The `volumechange` listener adopts a page-side volume change only if the user touched the page in the last 1s (or is holding the pointer down, for slider drags). Otherwise the change came from page code, e.g. Messenger setting a new participant's `<audio>` to 1, and gets reverted. Reverts are capped at 5/sec per element so a page that re-asserts its volume can't loop with us. Before this, call audio jumped back to 100% mid-call.
7. **The popup skips re-rendering when the set of tabs is unchanged** (`loadTabs`), so a slider drag isn't interrupted. If you add per-row live state, update it in place rather than relying on a re-render. Routing and unrouting call `reloadRows()`, which forces one re-render, because they change the row's slider range and Out controls.

These came up while building routing. 8 and 9 haven't been seen in a real browser yet:

8. **`runtime.sendMessage` reaches every extension page**, including the offscreen document and an open popup or setup tab. `offscreen.js` must ignore anything that isn't `OFFSCREEN_*` and never respond to it, or its empty reply can beat background's. For the same reason the popup must not message the offscreen document directly: background's listener replies to every message, including unknown ones, so it would race the offscreen reply. Go through background.
9. **Routed volume goes up to 2, but `el.volume` throws above 1.** Background clamps when a route ends (`endRoute`) and for unrouted tabs in `POPUP_SET_VOLUME`, which covers a popup row left open after the route ended. `endRoute` also sends `SET_VOLUME` before `SET_ROUTED {routed: false}`. In the other order, content.js would briefly apply its old boost value and throw.
10. **An `AudioContext` can die mid-route.** Chrome fires `error` on the context ("The AudioContext encountered an error from the audio device or the WebAudio renderer") on things like a Bluetooth profile switch, unplug, or sleep, and the context goes silent while the tab stays captured and muted. `offscreen.js` `recover()` rebuilds the graph from the same capture stream, carries the gain over, and retries the chosen sink; a second failure within 5s stops the capture and sends `ROUTE_ENDED` so the page plays normally again. Seen in a real browser 2026-10-31.

## Known gaps / candidate work

- On unrouted tabs, audio played through Web Audio (`AudioContext.destination`) or detached `new Audio()` elements isn't controlled. Routing the tab covers it. A MAIN-world hook (patch `HTMLMediaElement.prototype.play` to track detached elements, wrap connections to `destination` with a GainNode) would cover it without capture. Only build that if a real site needs it. Messenger calls work without it.
- Unrouted tabs cap at 100% because `el.volume` max is 1. Routed tabs go to 200% through the offscreen gain node. The manifest description still doesn't claim boost (the old one did and would have been a Web Store misrepresentation issue). Only claim it if boost works for every tab.
- While routed, `apply()` leaves element volume alone (set to 1 once in `setRouted`), so a site's own control multiplies with the offscreen gain. The popup only shows the gain, not the combined level.
- A routed tab's fullscreen is confined to the browser window, with the toolbar still showing (verified 2026-10-31). Chrome decides this when fullscreen is entered while the tab is captured. Known workaround (Volume Master's): start the capture after the video is already fullscreen, which needs a keyboard shortcut since opening the popup leaves fullscreen. A `commands` shortcut was built and dropped on 2026-11-01: Aside, the Chromium fork the user tests in, lists extension shortcuts but never delivered the command, and the user decided it wasn't needed.
- Routing checks never run in a real browser: whether a capture survives navigating the tab to another site (Testing, step 10), lip-sync latency on video, and what happens on a tab a call app is already screen-sharing or on DRM sites (Netflix, Spotify web).
- Idea, not started: choosing the global microphone *input* device from the Mic section (swap the source node in `mic-gain-hook.js`'s graph, keeping the destination track so the call never renegotiates). Full design: `git show 9d79116:NEXT_BUILD.md`.

## Testing

1. `chrome://extensions` → reload the unpacked extension. Don't refresh test tabs; re-injection should cover them (that's part of what you're testing).
2. Have a YouTube tab and a call tab (Messenger/Meet) open at once.
3. Confirm each tab's slider changes only that tab's volume, and that YouTube's own slider and the popup stay in sync.
4. In the call tab (has mic permission), confirm the Out dropdown lists devices and routing a tab to a different output works.
5. Change mic gain, then start a new call and confirm the other side hears the difference.
6. Routing, on YouTube (no site mic permission): click "Route this tab". The first time, the setup page opens. Grant, go back, reopen the popup, and route. Pick a different output than the call tab and confirm both play on their own device at their own volume. Set it to 150% and confirm it's louder than 100%.
7. Click "Route this tab" on a row that isn't the active tab. It should switch to that tab and show "Open the popup again to route", not fail silently. On a `chrome://` page or after something goes wrong, the row should show "Couldn't route: <reason>".
8. Stop routing: the tab returns to its in-page sink at its previous volume (capped at 100%). Close a routed tab: no orphaned `AudioContext` in the offscreen document's console (`chrome://extensions` → Inspect views: offscreen.html).
9. Leave the popup closed for over a minute so the worker stops. The routed tab keeps playing, and the popup still shows it as routed.
10. Navigate a routed tab to another site and note whether the capture survives. Either way the popup should match: still routed, or back to normal.

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
- Reuse `buildSlider` / `buildHint` / `renderPill` / `renderSelect(devices, actions)` in popup.js and `apply()` / `collectMedia()` in content.js rather than adding parallel helpers.
- Keep state in `storage.session` only (no cross-session persistence) unless the user asks. Any new state must be added to both `persist()` and the `ready` restore, or it will silently reset when the worker restarts.
- Don't commit or push unless the user asks. Commit style: Conventional Commits (`feat:`, `docs:`, `fix:`).
