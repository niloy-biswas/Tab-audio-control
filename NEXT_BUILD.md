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

# Per-tab microphone input gain (mic reducer)

## Context
The user wants a second slider, alongside the existing playback-volume slider, that turns their own *microphone input* down (or up) on a per-tab basis — e.g. quiet the mic on a Google Meet/Discord-web/Messenger-web call tab without touching the OS input level or muting.

## Feasibility / constraints (confirmed before designing)
- No extension or web API exposes the OS mic input level. The only lever available is intercepting the audio actually captured via `getUserMedia` inside the page and scaling that digital signal before the page (and any WebRTC connection it opens) ever receives it. This changes how loud the caller sounds to others, not the system mic slider.
- The override must live in the **page's own JS realm**, not the isolated world the existing `content.js` runs in — an isolated-world content script has a separate copy of `navigator`, so overriding `navigator.mediaDevices.getUserMedia` there would not affect the page's own calls. Manifest V3 supports a content script declared with `"world": "MAIN"` (Chrome 111+) for exactly this, with no extra permission.
- The MAIN-world script and the existing isolated `content.js` are separate JS contexts and share no objects — they need a `window.postMessage` bridge, then `content.js` relays to `background.js` exactly like today's messages.
- Only reachable for browser-tab WebRTC calls (Meet, Discord web, Messenger web, Zoom web, etc.). A desktop call app (Zoom.app, Discord desktop) captures mic outside any tab — extension has no access, same boundary as output routing has for non-tab audio.
- Unlike playback volume, there's no page-side "drift" to reconcile (call apps don't expose a control that writes back into our gain node) — this is one-way and simpler than the existing volume drift handling.
- `document_start` content scripts run before the page's own script executes, so the override should always win the race in practice. No known call app requests the mic synchronously on page load — all gate it behind a "join call" click — so this is treated as low risk, not solved defensively (see Known unverified risk).

## Design

### manifest.json
Add a second `content_scripts` entry:
```json
{
  "matches": ["<all_urls>"],
  "js": ["mic-gain-hook.js"],
  "world": "MAIN",
  "run_at": "document_start",
  "all_frames": true
}
```
`all_frames: true` because a call can run inside an embedded iframe (e.g. Meet embedded in another site).

### mic-gain-hook.js (new file, runs in MAIN world)
- Wraps `navigator.mediaDevices.getUserMedia`:
  - Calls the original to get the real `MediaStream`.
  - For each audio track in it: `MediaStreamSource` → `GainNode` (starts at gain `1`, i.e. unchanged) → `MediaStreamDestination`, via a fresh `AudioContext`. Swap the track in the stream that's returned to the caller for the destination's processed track; leave any video track untouched.
  - Register the new `GainNode` in a module-level `Map` keyed by the original track's id, so a later gain change can reach it.
  - On the original track's `ended` event: disconnect the audio graph, close the `AudioContext`, remove the map entry — so a hangup or mic-permission revoke cleans up fully.
- Listens for `window.postMessage({__tac: true, type: "SET_MIC_GAIN", gain})` (from `content.js`) and applies `gain` to every currently-live `GainNode`.
- Posts `{__tac: true, type: "MIC_CAPTURE_STARTED"}` on the first live capture and `MIC_CAPTURE_STOPPED` when the last one ends, so the rest of the extension knows whether this tab currently has an active mic capture worth showing a slider for.
- All messages tagged with `__tac: true` so the bridge can ignore unrelated `postMessage` traffic on the page.

### content.js (existing isolated-world file) — small bridge addition
- `window.addEventListener("message", ...)`, filtered to `event.source === window && event.data?.__tac`, relays `MIC_CAPTURE_STARTED` / `MIC_CAPTURE_STOPPED` to `background.js` via `chrome.runtime.sendMessage`.
- On a `SET_MIC_GAIN` message received *from* background, forwards it down into the page via `window.postMessage({__tac: true, type: "SET_MIC_GAIN", gain}, "*")` for `mic-gain-hook.js` to pick up.

### background.js
- Two new pieces of state, same lifecycle as `tabVolumes`:
  ```js
  const micGains = new Map();       // tabId -> gain (default 1)
  const micActiveTabs = new Set();  // tabIds with a currently live mic capture
  ```
- New message handlers, following the existing switch-statement pattern:
  - `MIC_CAPTURE_STARTED` / `MIC_CAPTURE_STOPPED` (content→bg): add/remove `sender.tab.id` from `micActiveTabs`.
  - `POPUP_GET_MIC_GAIN` (popup→bg): responds `{gain: micGains.get(msg.tabId) ?? 1}`.
  - `POPUP_SET_MIC_GAIN` (popup→bg): `micGains.set(msg.tabId, msg.gain)`, relay `SET_MIC_GAIN` to that tab (wrapped in try/catch, same as `POPUP_SET_VOLUME` does for an unreachable content script).
  - `GET_ALL_MIC_STATE` (popup→bg): responds `{gains: Object.fromEntries(micGains), active: [...micActiveTabs]}`, mirroring `GET_ALL_VOLUMES`.
- Extend the existing `tabs.onRemoved` listener to also delete from `micGains` and `micActiveTabs`.

### popup.js / popup.html
- Each row gets a second slider ("Mic"), rendered only when that tab id is in `micActiveTabs` — a tab with no live mic capture has nothing to control, so no row.
- Factor the slider-building logic already in `buildRow` into a small shared helper so the mic slider isn't a copy-pasted block.
- Range 0–100% only, no boost — the ask was to *reduce* the mouthpiece, and boosting raw mic gain risks clipping/distortion more readily than boosting media playback does.

## Edge cases handled
- Call app mutes by fully re-calling `getUserMedia` on unmute → new track gets a fresh `GainNode`, seeded from `micGains` (background is authoritative), not reset to `1`.
- Call app mutes via `track.enabled = false` instead → nothing to do, the existing `GainNode` stays wired and resumes correctly when re-enabled.
- Multiple concurrent `getUserMedia` calls in one tab → each gets its own `GainNode`; a gain change updates all of them; each cleans up independently on its own track ending.
- Tab captures mic but the user never touches the slider → gain stays `1`, fully transparent, no behavior change from today.

## Known unverified risk (flag, don't over-engineer around it)
Whether a `document_start` MAIN-world content script is guaranteed to install before every possible page call to `getUserMedia` isn't spec-guaranteed, only Chrome's documented content-script timing behavior. No known call app requests the mic synchronously on load, so don't add defensive polling/retry for this — confirm empirically once implemented instead.

## Verification
1. Reload the unpacked extension.
2. Open a Google Meet (or Discord web) tab and join/start a call.
3. Confirm the popup shows a "Mic" slider for that tab once the call has acquired the microphone.
4. Drag the mic slider down; confirm (via another participant, or a local loopback recording) the captured voice is quieter, with the OS mic level unchanged.
5. Mute/unmute inside the call app itself; confirm the slider position and effect still hold afterward.
6. Close the tab mid-call; confirm `micGains`/`micActiveTabs` no longer reference that tab id.

## Update: mic gain made global, not per-tab

Shipped, then changed on request: mic gain is **one value for the whole browser**, applied to whatever tab is currently capturing the mic, rather than tracked per tab. Rationale — the user only ever has one mouth, so one active call at a time is the normal case, and a single always-visible "Mic" control is simpler to reach than hunting for a specific tab's row.

- `background.js`: replaced `micGains` (`Map<tabId, gain>`) with a single `let micGain = 1`. `POPUP_SET_MIC_GAIN` now takes no `tabId`, and broadcasts `SET_MIC_GAIN` to **every open tab** (`chrome.tabs.query({}) → sendMessage`, each wrapped in `.catch(() => {})` same as existing per-tab sends) so any tab that later starts capturing picks up the current value immediately via its own `mic-gain-hook.js` instance. `micActiveTabs` (still per-tab) is kept only to know whether *any* site currently has a live capture — not for keying the gain itself.
- `content.js` / `mic-gain-hook.js`: **no changes needed** — the mic messages never carried a `tabId` to begin with (`SET_MIC_GAIN` only ever carried `gain`; `MIC_CAPTURE_STARTED`/`STOPPED` are read tab-side via `sender.tab.id` in background, not embedded in the message body), so the existing wiring was already tab-agnostic on the content-script side.
- `popup.js` / `popup.html`: removed the per-row "Mic" slider from `buildRow` (tab list rows are volume-only again). Added one fixed "Mic" section at the bottom of the popup, populated once via `POPUP_GET_MIC_GAIN` (no `tabId`) — separate from the tab list's diff-and-skip re-render logic, since it isn't part of that per-tab loop.
- Tab list filter still includes tabs with a live mic capture even if not `audible` (a call tab where you're only speaking, no incoming audio) — kept for surfacing the tab itself, not for a mic control on that row.
