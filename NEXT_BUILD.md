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
