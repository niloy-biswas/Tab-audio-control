# Hybrid tab-capture routing (opt-in, per tab)

## Context
Output routing today uses `HTMLMediaElement.setSinkId` inside the page. Chrome only reveals a site's output devices once that **site** has microphone permission, and Chrome has no `selectAudioOutput()`. So routing works on call sites (Messenger, Meet) but not on YouTube or most media sites, where the popup shows "Allow mic on this site to list outputs". The device IDs are also hashed per origin, so the extension can't lend one site's IDs to another.

The user chose a hybrid over a full rewrite. Keep today's content-script path as the default for every tab (volume with no indicator and no extra clicks). Add an opt-in **"Route this tab"** that captures the tab's audio with `chrome.tabCapture` and plays it back through the extension's own `AudioContext`. Chrome then checks the **extension's** device permission, not the site's. A routed tab also gets volume above 100% and coverage of Web Audio and detached `<audio>` elements, which the content-script path can't reach.

Mic gain is unaffected. It handles mic input, not tab output, and keeps using `mic-gain-hook.js`.

## Confirmed platform facts
- A stream ID from `chrome.tabCapture.getMediaStreamId()` obtained in the service worker can be used in an offscreen document (Chrome 116+). The offscreen document consumes it with `getUserMedia({ audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: id } } })`.
- Capturing a tab stops its audio playing to the user. The extension must play it back (source → destination), which is exactly where the gain and sink get applied.
- `AudioContext.setSinkId(deviceId)` exists since Chrome 110. Device IDs come from `enumerateDevices()`, and labels and non-default IDs need microphone permission for the calling origin (here, `chrome-extension://<id>`).
- Offscreen documents created with reason `AUDIO_PLAYBACK` are closed after 30s without audio. Other reasons have no lifetime limit, so use `USER_MEDIA`.

## Phase 0: verification build (do first, throwaway branch)
Answer these in a minimal build before writing the real thing. Any "no" changes the design below.

The feature was built on `feat/hybrid-tab-capture` before these were answered, so it's designed to hold up either way: `activeTab` is in the manifest, only the popup's own tab is routed, a captured track ending hands the tab back to content.js, and route failures show their reason in the popup. Each item's status below records what has been tested since.

1. **Invocation rule:** can the service worker get a stream ID for the tab the popup was opened over, using only the existing `<all_urls>` host permission, or does it need `activeTab`? Can it target a non-active tab at all? (Expected: active tab only, after the popup opens.)
   - Status: partly verified 2026-10-31. Routing the tab the popup was opened over works with `activeTab` in the manifest. Not tested: host permission alone, or targeting a non-active tab.
2. **Permission inheritance:** after a visible extension page grants mic once, does the offscreen document see labelled `audiooutput` devices and can it call `AudioContext.setSinkId` without its own prompt? (Offscreen documents are invisible and can't show prompts.)
   - Status: verified 2026-10-31. After the setup page grant, the offscreen document lists labelled outputs, and picking another device moves a routed tab's audio there while other tabs stay put.
3. **Navigation:** does a capture survive a same-tab navigation (e.g. YouTube → another site in the same tab), or does the track end?
   - Status: unverified, needs manual test
4. **Echo on calls:** route a Messenger call to the laptop speakers and have the other side listen. Does Chrome's echo cancellation still see the played-back audio, or does the other side hear themselves? With headphones this doesn't matter. With speakers it could block routing call tabs.
   - Status: verified 2026-10-31. A routed Messenger call on the laptop speakers produced no echo for the other side.
5. **Latency:** is lip-sync on YouTube noticeably off?
   - Status: unverified, needs manual test
6. **Conflicts:** what happens when routing a tab that a call app is already screen-sharing, and on DRM sites (Netflix, Spotify web)?
   - Status: unverified, needs manual test

## Design

### New files
- **offscreen.html / offscreen.js**: the single audio engine. `routes = Map<tabId, { stream, ctx, gain }>`, one `AudioContext` per routed tab (`setSinkId` is per context). Graph: `MediaStreamSource → GainNode → ctx.destination`. Handles `OFFSCREEN_START {tabId, streamId, gain, sinkId}`, `OFFSCREEN_SET_GAIN`, `OFFSCREEN_SET_SINK`, `OFFSCREEN_STOP`, and `OFFSCREEN_GET_DEVICES` (enumerates from the extension origin). When a captured track ends (tab closed, or navigation if Phase 0 says so), it sends `ROUTE_ENDED {tabId}` and cleans up.
- **setup.html / setup.js**: a one-time visible page that calls `getUserMedia({audio: true})`, stops the tracks immediately, and says "Done, you can close this tab". This only unlocks device names for the extension; it never records. It reuses popup styling where possible instead of new CSS.

### background.js
- New state `tabRouted = Map<tabId, { sinkId }>`, added to both `persist()` and the `ready` restore (see AGENTS.md: forgetting either means it silently resets when the worker restarts). Cleared in `tabs.onRemoved` and on `ROUTE_ENDED`.
- `ensureOffscreen()`: create the document with reason `USER_MEDIA` if it doesn't exist (`chrome.offscreen.hasDocument` / `runtime.getContexts`).
- `POPUP_ROUTE_TAB {tabId}`: `getMediaStreamId({targetTabId})` → `ensureOffscreen()` → `OFFSCREEN_START` with the tab's stored volume as the gain → tell the tab `SET_ROUTED {routed: true}`.
- `POPUP_SET_VOLUME` / `POPUP_SET_SINK_ID`: if the tab is routed, forward to the offscreen document instead of the content script.
- `POPUP_UNROUTE_TAB`: `OFFSCREEN_STOP`, then `SET_ROUTED {routed: false}` so the content-script path takes over again with the stored volume and sink.
- On a worker restart the offscreen document and its captures keep running (separate context), so the restored `tabRouted` still matches reality. After a browser restart both are gone, and `storage.session` is cleared anyway.

### content.js
- `SET_ROUTED {routed}`: on route, set `el.volume = 1` once and then leave element volume to the page (built: forcing it every rescan made YouTube's own slider snap back), reset the sink to `""`, and skip drift handling. The offscreen gain is applied after the page's own volume, so Messenger setting 100% no longer matters and nothing needs reverting. On unroute, resume normal `apply()` with the stored values.
- Only a flag checked in `apply()` and the `volumechange` listener, not a second code path.

### popup.js
- In the Out row, where it shows "Allow mic on this site to list outputs" today, show a **"Route this tab"** button instead.
  - Active tab: start routing. If the extension lacks mic permission (`navigator.permissions.query({name: "microphone"})` from the popup), open `setup.html` first.
  - Non-active tab: the button focuses that tab (`tabs.update` + `windows.update`) with the hint "Open the popup again to route". This follows Chrome's invocation rule (Phase 0, item 1).
- A routed row shows a device dropdown from `OFFSCREEN_GET_DEVICES` and a "Stop routing" option at the bottom. The slider max goes to 200% and the readout shows the boost.
- Tabs where the site already has mic permission (Facebook today) keep the current in-page routing. No capture indicator for them.

### manifest.json
- Add `"tabCapture"` and `"offscreen"`, plus `"activeTab"` if Phase 0 shows it's needed.

## Edge cases
- **Routed tab closes:** `ROUTE_ENDED` / `tabs.onRemoved` stop the context and clear state.
- **Routed device unplugged:** the offscreen `devicechange` handler falls back to `setSinkId("")` for every context on that device and reports it, same as `SINK_DEVICE_UNAVAILABLE` today.
- **Extension reload:** captures die with the old offscreen document, and `storage.session` clears. Tabs fall back to the content-script path at defaults. The user re-routes (an accepted limitation of the invocation rule).
- **Mic permission revoked for the extension later:** the device list goes back to default only, and the row shows the setup button again.
- **Two windows:** the invocation rule is per tab, so each routed tab needs its own popup open while active.

## Store and privacy impact
- `PRIVACY.md` needs a new section: "When you route a tab, the extension captures that tab's audio and plays it back to the device you chose. Audio is never recorded, stored, or sent." The permissions table gains `tabCapture`, `offscreen`, and the one-time mic grant used to list devices.
- `tabCapture` is a sensitive permission. Expect a longer review and write the justification around the user-initiated, per-tab, play-back-only behavior.
- README limitations: routed tabs show Chrome's capture indicator; routing needs the popup opened on that tab after each browser restart.

## Out of scope
- Replacing the content-script path for unrouted tabs.
- Remembering routes across browser restarts (Chrome requires a fresh user invocation anyway).
- Boost for unrouted tabs.

## Verification
1. Phase 0 answers recorded at the top of this section before building.
2. Reload the extension. On YouTube (no site mic permission), click "Route this tab" → setup page → grant → reopen popup → route to Bluetooth while a Messenger call stays on built-in speakers. Both play correctly at their own volume.
3. Set YouTube to 150% and confirm it's louder than 100%.
4. On a routed Messenger call, have someone join or leave. Volume stays put.
5. Stop routing. The tab returns to the default device at its previous volume with no gap longer than a moment.
6. Close a routed tab. No orphaned `AudioContext` remains (check `chrome://media-internals` or the offscreen document's console).
7. Unplug the routed device mid-playback. That tab falls back to the default device, and the others don't change.
8. Leave the popup closed for over a minute so the service worker stops. Routed tabs keep playing, and the popup still shows them as routed.

---

# Per-tab output device routing (Tab Volume Mixer)

## Context
The extension currently controls per-tab *volume* only. The user wants to also route each tab's audio *output* to a different physical device at the same time — e.g. YouTube's tab plays through Bluetooth headphones while a Facebook call tab plays through the MacBook's built-in speakers, chosen from this same extension.

The only web-platform way to do this is `HTMLMediaElement.setSinkId(deviceId)` (Audio Output Devices API), which lets each media element be routed to a device independently — confirmed as the right tool. It's gated behind the `speaker-selection` permission, granted via `navigator.mediaDevices.selectAudioOutput()`, which **requires a real user gesture in that exact page** — a click inside the extension's popup does not count (confirmed: no `chrome.*` API forwards activation from a popup into a tab's document). So this feature needs a small on-page trigger the user clicks directly, once per device per site — the user has confirmed this UX is acceptable. The user also confirmed no cross-session persistence is wanted: every tab starts at "System Default" output; device choice is picked manually each time, same lifecycle as volume today (memory-only, cleared on tab close).

## Design

### State (background.js)
Add a second memory-only map, same lifecycle as the existing `tabVolumes`:
```
tabSinks = new Map(); // tabId -> sinkId string ('' = system default)
```
No `chrome.storage` backing — matches the "always start at default" decision. Cleared in the existing `tabs.onRemoved` listener alongside `tabVolumes`.

### Messages (extend the existing pattern in background.js)
| Message | Direction | Purpose |
|---|---|---|
| `CONTENT_READY` (existing) | content→bg | response also includes `sinkId: tabSinks.get(tabId) ?? ''` |
| `POPUP_GET_DEVICES` | popup→bg→content (relay `REQUEST_DEVICE_LIST`) | returns `{granted, devices:[{deviceId,label}]}` for that tab |
| `POPUP_SET_SINK_ID` | popup→bg | `tabSinks.set(tabId, sinkId)`, relay `SET_SINK_ID` to the tab |
| `POPUP_REQUEST_GRANT` | popup→bg→content (relay `SHOW_SINK_PICKER`) | tells content.js to reveal its on-page trigger button |
| `SINK_DEVICES_UPDATED` | content→bg | after a successful grant or a `devicechange` event, mirrors the existing `VOLUME_DRIFTED` handler shape |
| `SINK_DEVICE_UNAVAILABLE` | content→bg | the currently-applied device disappeared (unplugged) — background resets that tab's `tabSinks` entry to `''` |

### content.js
- Add `let currentSinkId = '';`.
- Extend `apply(el)` (the single function already used by `scan()`, `setVolume()`, the MutationObserver, and the 1s fallback poll) to also call `setSinkId`:
  ```js
  function apply(el) {
    el.volume = currentVolume;
    if (currentSinkId && typeof el.setSinkId === "function") {
      el.setSinkId(currentSinkId).catch(() => {
        // stale/removed device — report and fall back
        chrome.runtime.sendMessage({ type: "SINK_DEVICE_UNAVAILABLE" }).catch(() => {});
      });
    }
  }
  ```
  Because every code path that discovers media elements already funnels through `apply()`, newly-hooked elements (including ones inside shadow roots, per the existing YouTube handling) automatically pick up the current sink — no extra hook logic needed, same reuse pattern that already makes volume "just work."
- Add `setSinkId(id)` sibling to the existing `setVolume(v)`, same shape (set `currentSinkId`, re-collect media, re-apply).
- `init()`'s existing `CONTENT_READY` round trip also seeds `currentSinkId` from the response.
- Scope all NEW device/permission logic to the top frame only: `if (window.self !== window.top) return;` before wiring it up — sub-frames keep getting volume control as today, but only one on-page button/permission flow per tab, and it avoids wasting `selectAudioOutput()` calls in cross-origin iframes that are policy-blocked by default anyway.
- `enumerateAndReport()`: calls `navigator.mediaDevices.enumerateDevices()`, filters `kind === "audiooutput"`; presence of any non-empty `label` = granted. Sends the result on `REQUEST_DEVICE_LIST` replies and proactively on `navigator.mediaDevices.ondevicechange` (also used to detect the current device vanishing → fall back to `''`, re-apply, send `SINK_DEVICE_UNAVAILABLE`).
- On-page trigger: a small fixed-position pill, injected in its own shadow root (consistent with how this codebase already treats shadow DOM) so it can't collide with host page CSS. Hidden by default; shown on `SHOW_SINK_PICKER`. On click:
  ```js
  navigator.mediaDevices.selectAudioOutput()
    .then(() => enumerateAndReport())
    .catch(() => { /* user dismissed, or NotAllowedError/AbortError — just report failure, no retry loop */ });
  ```
  Auto-hide a few seconds after a successful pick or after inactivity; it's re-summonable via `SHOW_SINK_PICKER` since the user may need to grant additional devices later (permission appears to be granted per-device, not blanket-per-origin — flagged as unverified below).

### background.js
- Add `tabSinks` map and the message handlers in the table above, following the exact structure already used for `tabVolumes`/`VOLUME_DRIFTED`.
- Wrap the relay calls in try/catch like the existing `POPUP_SET_VOLUME` handler (content script may not be reachable, e.g. `chrome://` pages).

### popup.js / popup.html
- Each row (`buildRow`) gets a compact device `<select>` next to the existing volume slider, populated by `POPUP_GET_DEVICES` (fetched after the row renders, so it doesn't block or interfere with the existing same-tab-set-skip re-render guard that protects in-progress volume drags).
  - Granted + has devices → `<select>`: "System Default" (`''`) + each device label + a trailing "Add device…" option.
  - Not granted (or "Add device…" picked) → small "Grant on page…" pill that sends `POPUP_REQUEST_GRANT`, with inline hint text ("click the button that appears on the tab").
  - Selecting a device sends `POPUP_SET_SINK_ID`.
- No change to the existing tab-list filter — a tab is shown if `tab.audible` or it has a stored volume; extend the condition to also include tabs with a stored `sinkId`, so a routing choice doesn't vanish from the list the moment a tab goes quiet.

## Edge cases handled
- Device unplugged mid-playback → `ondevicechange` fallback to default, reported via `SINK_DEVICE_UNAVAILABLE`.
- Permission not yet granted → popup shows "Grant on page…" instead of a device list.
- Restrictive Permissions-Policy blocking `speaker-selection` on some site → `setSinkId`/`selectAudioOutput` calls simply reject; caught and surfaced as a failure state in the popup (no proactive `permissionsPolicy.allowsFeature` check — that API's availability is unconfirmed, so don't depend on it for MVP).
- Multiple media elements in one tab → all follow the same tab-level `currentSinkId` for free, via the shared `apply()`.
- No persistence anywhere (matches the user's decision) — a reload or new tab always starts at System Default.

## Known unverified risk (flag, don't over-engineer around it)
Whether `selectAudioOutput()` grants are per-device or blanket-per-origin is unconfirmed from docs alone — real behavior may mean the on-page button needs clicking again per *new* device rather than truly once-per-site-forever. Don't build extra plumbing for this; just keep the trigger easily re-summonable (already planned) and confirm actual behavior once implemented.

## Verification
1. Reload the unpacked extension, hard-refresh test tabs (existing project workflow).
2. Open a YouTube tab and a Messenger/Facebook call tab simultaneously.
3. In each tab, click the on-page trigger once, pick a distinct output device (e.g. headphones for YouTube, MacBook speakers for the call) via the native chooser.
4. Confirm both play concurrently through their assigned device with correct independent volumes from the existing slider.
5. Unplug/disconnect one chosen device mid-playback and confirm that tab falls back to system default audibly, without affecting the other tab.
6. Close and reopen one of the tabs, confirm it starts back at System Default (no persistence leak).

---

# Global microphone input device selection

## Context
Alongside the shipped mic-gain control (one global gain applied to whatever tab is capturing mic), the user also wants to choose *which physical microphone* is used — e.g. default to the Mac's built-in mic, but switch to a connected headset's mic when preferred — from the same "Mic" section in the popup. Confirmed global scope (same as gain), not per-tab: only one microphone reaches the user's mouth at a time.

## Feasibility / constraints
- No special permission needed beyond the microphone permission a call tab's own `getUserMedia` call already obtained for that origin — unlike output-device routing above, there is no separate permission or user-gesture requirement for picking a different input device. Once mic permission is granted for an origin, `navigator.mediaDevices.enumerateDevices()` returns labeled `kind: "audioinput"` entries, and further `getUserMedia({audio: {deviceId: {exact: id}}})` calls for that origin succeed without a new prompt.
- `mic-gain-hook.js` already builds, per captured track, a `MediaStreamSource → GainNode → MediaStreamDestination` graph and hands the call app the **destination**'s track, not the raw mic track. Switching input device is therefore just swapping the graph's *source*: request a fresh raw stream from the chosen device via the original (unwrapped) `getUserMedia`, connect its track into the *same* `GainNode`, disconnect and stop the old source's track. The destination track already in use by the call/RTCPeerConnection never changes — no renegotiation, no rejoin, no interruption visible to the call app.
- Device *labels* require permission already granted somewhere this session — if no tab has captured mic yet, the popup's device list may be empty. Handled by showing "System Default" as a placeholder until some tab grants permission and reports real devices.

## Design

### mic-gain-hook.js
- Extend the per-track registry to `{ trackId, gainNode, sourceNode, ctx }` (was `{gainNode, ctx}`) so the source can be swapped later.
- New handler for a `SET_MIC_DEVICE` postMessage: for every active entry, call the **original**, unwrapped `getUserMedia({audio: {deviceId: {exact: deviceId}}})` (bypassing our own override to avoid recursion), build a new `MediaStreamSource` from the returned track, connect it to the existing `gainNode`, then disconnect the old source and `stop()` its raw track. Track `currentDeviceId`.
- `enumerateAndReport()`: calls `enumerateDevices()`, filters `audioinput`, posts `MIC_DEVICES_UPDATED` with `{devices: [{deviceId, label}], activeId: currentDeviceId}`. Runs right after the first successful capture (permission is now definitely granted) and again on `navigator.mediaDevices.ondevicechange` (covers headset plug/unplug).
- If the active device disappears (`devicechange` fires and it's no longer in the enumerated list): fall back automatically to `getUserMedia({audio: true})` (system default), swap source the same way, and report the fallback via the same `MIC_DEVICES_UPDATED` message so the popup's selection updates itself.

### content.js bridge
- Relay `MIC_DEVICES_UPDATED` up to background, same pattern as the existing `MIC_CAPTURE_STARTED` relay.
- Relay `SET_MIC_DEVICE` down from background into the page, same shape as the existing `SET_MIC_GAIN` relay.

### background.js
- New state: `let micDevices = { devices: [], activeId: null }`, `let preferredMicDeviceId = null`, and `let lastMicDeviceTabId = null` (the tab whose report is authoritative — the one currently on a call, same "whichever tab is capturing" reasoning already used for gain).
- `MIC_DEVICES_UPDATED` (content→bg): store into `micDevices`, remember `sender.tab.id` as `lastMicDeviceTabId`.
- `POPUP_SET_MIC_DEVICE` (popup→bg): `preferredMicDeviceId = msg.deviceId`; relay `SET_MIC_DEVICE` to `lastMicDeviceTabId` only if one is currently capturing (not broadcast to every tab like gain — swapping a device on a tab with no active capture is meaningless, and could even start one unexpectedly).
- Extend the `CONTENT_READY` response to also include `preferredMicDeviceId`, mirroring how `micGain` already seeds new captures — so a *new* call started after the preference was set opens directly on the right device instead of the system default.
- `GET_ALL_MIC_STATE` extended to also return `{ devices: micDevices.devices, activeId: micDevices.activeId }`.

### popup.js/html
- Extend the existing global "Mic" section (below the gain slider) with a compact `<select>` of input devices, populated from `GET_ALL_MIC_STATE`. Selecting one sends `POPUP_SET_MIC_DEVICE`.
- Empty `devices` list (no capture has happened yet this session) → show "System Default" as the only option; repopulates once some tab has captured mic at least once.

## Edge cases
- No tab currently capturing when the user changes the preference → nothing to apply live; stored as `preferredMicDeviceId`, applied via `CONTENT_READY` the next time any tab's `getUserMedia` fires.
- Chosen device unplugged mid-call → automatic fallback to system default (see mic-gain-hook.js above); popup dropdown reflects the change on next open.
- Two tabs on calls simultaneously → device swap only targets `lastMicDeviceTabId`, a real limitation of the confirmed global-scope decision — same tradeoff already accepted for gain, not solved here.

## Known unverified risk
Whether calling `getUserMedia` again for a different `deviceId`, well after the original permission grant and with no fresh click, is allowed without re-prompting is expected per spec (a gesture is required only for the *original* grant, not a later device switch) but should be confirmed empirically once implemented — same category of assumption already flagged for the gain feature's injection timing.

## Verification
1. Reload extension. Join a call in a tab with two mic-capable devices connected (e.g. built-in mic + USB headset).
2. Open popup, confirm the Mic section's device dropdown lists both, with the one currently in use pre-selected.
3. Switch selection; confirm (via another participant or loopback) the audio source changes without dropping or rejoining the call.
4. Unplug the active device mid-call; confirm automatic fallback to default and the dropdown updates to reflect it.
5. With no call active anywhere, change the device preference, then join a call; confirm the new capture starts on the chosen device from the start.
