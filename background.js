const tabVolumes = new Map();
let micGain = 1; // applies to mic capture on every site, not per tab
const micActiveTabs = new Set(); // tabIds with a currently live mic capture
const tabSinks = new Map(); // tabId -> sinkId ('' = system default)
const tabSinkDevices = new Map(); // tabId -> {granted, devices, supported} — last known, used as a fallback if the live relay below fails
// tabId -> {sinkId} for tabs captured and played back by offscreen.js. The
// sinkId is enumerated by the extension's origin, so it's kept apart from
// tabSinks (site-origin IDs), which comes back into use on unroute.
const tabRouted = new Map();

// MV3 stops this worker after ~30s idle, wiping the globals above; any page
// or frame loading after that got volume 1 from CONTENT_READY, so calls
// jumped back to full volume. storage.session survives worker restarts but
// is still cleared on browser close / extension reload, so tabs keep
// starting at defaults like before.
const toEntries = (obj) =>
  Object.entries(obj ?? {}).map(([k, v]) => [Number(k), v]);

const ready = chrome.storage.session
  .get("state")
  .then(({ state }) => {
    if (!state) return;
    micGain = state.micGain ?? 1;
    toEntries(state.tabVolumes).forEach(([k, v]) => tabVolumes.set(k, v));
    toEntries(state.tabSinks).forEach(([k, v]) => tabSinks.set(k, v));
    toEntries(state.tabSinkDevices).forEach(([k, v]) =>
      tabSinkDevices.set(k, v),
    );
    (state.micActiveTabs ?? []).forEach((id) => micActiveTabs.add(id));
    // The offscreen document and its captures outlive a worker restart, so
    // this still matches what's playing.
    toEntries(state.tabRouted).forEach(([k, v]) => tabRouted.set(k, v));
  })
  .catch(() => {});

// Whole-state snapshot: tiny, and taken synchronously after each mutation,
// so out-of-order writes can't leave a mix of old and new values.
function persist() {
  chrome.storage.session
    .set({
      state: {
        micGain,
        tabVolumes: Object.fromEntries(tabVolumes),
        tabSinks: Object.fromEntries(tabSinks),
        tabSinkDevices: Object.fromEntries(tabSinkDevices),
        micActiveTabs: [...micActiveTabs],
        tabRouted: Object.fromEntries(tabRouted),
      },
    })
    .catch(() => {});
}

async function broadcastMicGain() {
  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    chrome.tabs
      .sendMessage(tab.id, { type: "SET_MIC_GAIN", gain: micGain })
      .catch(() => {});
  });
}

// USER_MEDIA, not AUDIO_PLAYBACK: Chrome closes AUDIO_PLAYBACK documents
// after 30s of silence, which would end every capture during a pause.
let creatingOffscreen = null;
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
  });
  if (contexts.length > 0) return;
  creatingOffscreen ??= chrome.offscreen
    .createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification:
        "Plays back a tab's captured audio at the volume and on the output device the user chose",
    })
    .finally(() => {
      creatingOffscreen = null;
    });
  await creatingOffscreen;
}

// tabCapture needs the extension to have been invoked on the tab (opening
// the popup over it), so the popup only sends this for its own active tab.
async function routeTab(tabId) {
  const streamId = await chrome.tabCapture.getMediaStreamId({
    targetTabId: tabId,
  });
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({
    type: "OFFSCREEN_START",
    tabId,
    streamId,
    gain: tabVolumes.get(tabId) ?? 1,
  });
  if (!res?.ok) throw new Error(res?.error || "Playback didn't start");
  tabRouted.set(tabId, { sinkId: "" });
  persist();
  chrome.tabs
    .sendMessage(tabId, { type: "SET_ROUTED", routed: true })
    .catch(() => {});
}

// Fire-and-forget to offscreen.js. Rejects if the document is gone (e.g.
// nothing has been routed yet), which needs no handling.
function notifyOffscreen(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

function stopCapture(tabId) {
  notifyOffscreen({ type: "OFFSCREEN_STOP", tabId });
}

// Hands the tab back to content.js with its stored volume and in-page sink.
// Shared by Stop routing and by the capture ending on its own.
function endRoute(tabId) {
  if (!tabRouted.delete(tabId)) return;
  // In-page volume can't boost: el.volume throws above 1.
  const volume = Math.min(tabVolumes.get(tabId) ?? 1, 1);
  if (tabVolumes.has(tabId)) tabVolumes.set(tabId, volume);
  persist();
  // SET_VOLUME first: content.js applies its stored volume as soon as it's
  // unrouted, and that may still be a boost value above 1.
  chrome.tabs
    .sendMessage(tabId, { type: "SET_VOLUME", volume })
    .catch(() => {});
  chrome.tabs
    .sendMessage(tabId, { type: "SET_ROUTED", routed: false })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // The message that woke the worker can arrive before state is restored.
  // Handlers return false when they won't respond; close the channel then
  // so the sender's promise settles instead of hanging.
  ready.then(() => {
    if (!handleMessage(msg, sender, sendResponse)) sendResponse();
  });
  return true;
});

function handleMessage(msg, sender, sendResponse) {
  switch (msg.type) {
    case "CONTENT_READY": {
      const tabId = sender.tab?.id;
      sendResponse({
        volume: tabVolumes.get(tabId) ?? 1,
        micGain,
        sinkId: tabSinks.get(tabId) ?? "",
        routed: tabRouted.has(tabId),
      });
      return true;
    }
    case "POPUP_SET_VOLUME": {
      const routed = tabRouted.has(msg.tabId);
      // Only a routed tab's gain node can boost; a popup row left open after
      // the route ended can still send up to 2.
      const volume = routed ? msg.volume : Math.min(msg.volume, 1);
      tabVolumes.set(msg.tabId, volume);
      persist();
      if (routed) {
        notifyOffscreen({
          type: "OFFSCREEN_SET_GAIN",
          tabId: msg.tabId,
          gain: volume,
        });
      } else {
        chrome.tabs
          .sendMessage(msg.tabId, { type: "SET_VOLUME", volume })
          .catch(() => {});
      }
      sendResponse({ ok: true });
      return true;
    }
    case "GET_ALL_VOLUMES": {
      sendResponse(Object.fromEntries(tabVolumes));
      return true;
    }
    case "VOLUME_DRIFTED": {
      const tabId = sender.tab?.id;
      // A frame that hasn't seen SET_ROUTED yet must not overwrite the gain.
      if (tabId != null && !tabRouted.has(tabId)) {
        tabVolumes.set(tabId, msg.volume);
      }
      persist();
      return false;
    }
    case "POPUP_GET_MIC_GAIN": {
      sendResponse({ gain: micGain });
      return true;
    }
    case "POPUP_SET_MIC_GAIN": {
      micGain = msg.gain;
      persist();
      broadcastMicGain();
      sendResponse({ ok: true });
      return true;
    }
    case "GET_ALL_MIC_STATE": {
      sendResponse({ gain: micGain, active: [...micActiveTabs] });
      return true;
    }
    case "MIC_CAPTURE_STARTED": {
      const tabId = sender.tab?.id;
      if (tabId != null) micActiveTabs.add(tabId);
      persist();
      return false;
    }
    case "MIC_CAPTURE_STOPPED": {
      const tabId = sender.tab?.id;
      if (tabId != null) micActiveTabs.delete(tabId);
      persist();
      return false;
    }
    case "GET_ALL_SINKS": {
      sendResponse(Object.fromEntries(tabSinks));
      return true;
    }
    case "POPUP_GET_DEVICES": {
      // A routed tab plays from the offscreen document, which can only use
      // device IDs enumerated by the extension's own origin.
      const routed = tabRouted.has(msg.tabId);
      const fallback = () =>
        routed
          ? { granted: false, devices: [] }
          : (tabSinkDevices.get(msg.tabId) ?? {
              granted: false,
              devices: [],
              supported: false,
              reachable: false,
            });
      (routed
        ? chrome.runtime.sendMessage({ type: "OFFSCREEN_GET_DEVICES" })
        : chrome.tabs.sendMessage(msg.tabId, { type: "REQUEST_DEVICE_LIST" })
      )
        .then((res) => sendResponse(res ?? fallback()))
        .catch(() => sendResponse(fallback()));
      return true;
    }
    case "POPUP_SET_SINK_ID": {
      if (tabRouted.has(msg.tabId)) {
        tabRouted.set(msg.tabId, { sinkId: msg.sinkId });
        notifyOffscreen({
          type: "OFFSCREEN_SET_SINK",
          tabId: msg.tabId,
          sinkId: msg.sinkId,
        });
      } else {
        tabSinks.set(msg.tabId, msg.sinkId);
        chrome.tabs
          .sendMessage(msg.tabId, { type: "SET_SINK_ID", sinkId: msg.sinkId })
          .catch(() => {});
      }
      persist();
      sendResponse({ ok: true });
      return true;
    }
    case "GET_ALL_ROUTES": {
      sendResponse(Object.fromEntries(tabRouted));
      return true;
    }
    case "POPUP_ROUTE_TAB": {
      routeTab(msg.tabId).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: e?.message || String(e) }),
      );
      return true;
    }
    case "POPUP_UNROUTE_TAB": {
      stopCapture(msg.tabId);
      endRoute(msg.tabId);
      sendResponse({ ok: true });
      return true;
    }
    // From offscreen.js, which has no tab, so the tabId is in the message.
    case "ROUTE_ENDED": {
      endRoute(msg.tabId);
      return false;
    }
    case "ROUTE_SINK_UNAVAILABLE": {
      if (tabRouted.has(msg.tabId)) {
        tabRouted.set(msg.tabId, { sinkId: "" });
        persist();
      }
      return false;
    }
    case "POPUP_REQUEST_GRANT": {
      chrome.tabs
        .sendMessage(msg.tabId, { type: "SHOW_SINK_PICKER" })
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    case "SINK_DEVICES_UPDATED": {
      const tabId = sender.tab?.id;
      if (tabId != null) {
        tabSinkDevices.set(tabId, {
          granted: msg.granted,
          devices: msg.devices,
          supported: msg.supported,
        });
      }
      persist();
      return false;
    }
    case "SINK_DEVICE_UNAVAILABLE": {
      const tabId = sender.tab?.id;
      if (tabId != null) tabSinks.set(tabId, "");
      persist();
      return false;
    }
  }
  return false;
}

// Manifest content scripts only land in tabs loaded *after* the extension
// is (re)loaded. Without this, a tab already open — e.g. a call in progress —
// gets no controls at all until it's refreshed, which would end the call.
chrome.runtime.onInstalled.addListener(async () => {
  const tabs = await chrome.tabs.query({ url: ["http://*/*", "https://*/*"] });
  tabs.forEach((tab) => {
    const target = { tabId: tab.id, allFrames: true };
    chrome.scripting
      .executeScript({ target, files: ["content.js"] })
      .catch(() => {});
    chrome.scripting
      .executeScript({ target, files: ["mic-gain-hook.js"], world: "MAIN" })
      .catch(() => {});
  });
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await ready;
  if (tabRouted.delete(tabId)) stopCapture(tabId);
  tabVolumes.delete(tabId);
  micActiveTabs.delete(tabId);
  tabSinks.delete(tabId);
  tabSinkDevices.delete(tabId);
  persist();
});
