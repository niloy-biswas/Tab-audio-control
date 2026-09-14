const tabVolumes = new Map();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "CONTENT_READY": {
      const tabId = sender.tab?.id;
      sendResponse({ volume: tabVolumes.get(tabId) ?? 1 });
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
  }
});

chrome.tabs.onRemoved.addListener((tabId) => tabVolumes.delete(tabId));
