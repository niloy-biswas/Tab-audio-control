const tabVolumes = new Map();
let micGain = 1; // applies to mic capture on every site, not per tab
const micActiveTabs = new Set(); // tabIds with a currently live mic capture
const tabSinks = new Map(); // tabId -> sinkId ('' = system default)
const tabSinkDevices = new Map(); // tabId -> {granted, devices, supported} — last known, used as a fallback if the live relay below fails

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
      });
      return true;
    }
    case "POPUP_GET_VOLUME": {
      sendResponse({ volume: tabVolumes.get(msg.tabId) ?? 1 });
      return true;
    }
    case "POPUP_SET_VOLUME": {
      tabVolumes.set(msg.tabId, msg.volume);
      persist();
      chrome.tabs
        .sendMessage(msg.tabId, { type: "SET_VOLUME", volume: msg.volume })
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
    }
    case "GET_ALL_VOLUMES": {
      sendResponse(Object.fromEntries(tabVolumes));
      return true;
    }
    case "VOLUME_DRIFTED": {
      const tabId = sender.tab?.id;
      if (tabId != null) tabVolumes.set(tabId, msg.volume);
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
      const fallback = () =>
        tabSinkDevices.get(msg.tabId) ?? {
          granted: false,
          devices: [],
          supported: false,
          reachable: false,
        };
      chrome.tabs
        .sendMessage(msg.tabId, { type: "REQUEST_DEVICE_LIST" })
        .then((res) => sendResponse(res ?? fallback()))
        .catch(() => sendResponse(fallback()));
      return true;
    }
    case "POPUP_SET_SINK_ID": {
      tabSinks.set(msg.tabId, msg.sinkId);
      persist();
      chrome.tabs
        .sendMessage(msg.tabId, { type: "SET_SINK_ID", sinkId: msg.sinkId })
        .catch(() => {});
      sendResponse({ ok: true });
      return true;
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
  tabVolumes.delete(tabId);
  micActiveTabs.delete(tabId);
  tabSinks.delete(tabId);
  tabSinkDevices.delete(tabId);
  persist();
});
