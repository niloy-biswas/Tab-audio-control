const tabVolumes = new Map();
let micGain = 1; // applies to mic capture on every site, not per tab
const micActiveTabs = new Set(); // tabIds with a currently live mic capture

async function broadcastMicGain() {
  const tabs = await chrome.tabs.query({});
  tabs.forEach((tab) => {
    chrome.tabs
      .sendMessage(tab.id, { type: "SET_MIC_GAIN", gain: micGain })
      .catch(() => {});
  });
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "CONTENT_READY": {
      const tabId = sender.tab?.id;
      sendResponse({
        volume: tabVolumes.get(tabId) ?? 1,
        micGain,
      });
      return true;
    }
    case "POPUP_GET_VOLUME": {
      sendResponse({ volume: tabVolumes.get(msg.tabId) ?? 1 });
      return true;
    }
    case "POPUP_SET_VOLUME": {
      tabVolumes.set(msg.tabId, msg.volume);
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
      return false;
    }
    case "POPUP_GET_MIC_GAIN": {
      sendResponse({ gain: micGain });
      return true;
    }
    case "POPUP_SET_MIC_GAIN": {
      micGain = msg.gain;
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
      return false;
    }
    case "MIC_CAPTURE_STOPPED": {
      const tabId = sender.tab?.id;
      if (tabId != null) micActiveTabs.delete(tabId);
      return false;
    }
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabVolumes.delete(tabId);
  micActiveTabs.delete(tabId);
});
