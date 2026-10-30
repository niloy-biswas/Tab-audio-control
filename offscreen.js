// Plays back routed tabs. Capturing a tab mutes it for the user, so each
// capture goes MediaStreamSource -> GainNode -> destination here, which is
// where the tab's volume (up to 2x) and output device get applied. One
// AudioContext per tab, because setSinkId is per context.
const routes = new Map(); // tabId -> {stream, ctx, gain, sinkId}

function stop(tabId) {
  const route = routes.get(tabId);
  if (!route) return;
  routes.delete(tabId);
  route.stream.getTracks().forEach((t) => t.stop());
  route.ctx.close().catch(() => {});
}

async function start({ tabId, streamId, gain }) {
  stop(tabId);
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });
  const ctx = new AudioContext();
  const gainNode = ctx.createGain();
  gainNode.gain.value = gain;
  ctx
    .createMediaStreamSource(stream)
    .connect(gainNode)
    .connect(ctx.destination);
  const route = { stream, ctx, gain: gainNode, sinkId: "" };
  routes.set(tabId, route);
  // The tab closed (or navigated, if Chrome ends captures on that). Our own
  // stop() doesn't fire "ended", so this only reports captures we didn't end.
  stream.getAudioTracks()[0]?.addEventListener("ended", () => {
    if (routes.get(tabId) !== route) return;
    stop(tabId);
    chrome.runtime.sendMessage({ type: "ROUTE_ENDED", tabId }).catch(() => {});
  });
}

// Same fallback as content.js's resetSinkToDefault, for one routed tab.
function resetSink(tabId, route) {
  route.sinkId = "";
  route.ctx.setSinkId("").catch(() => {});
  chrome.runtime
    .sendMessage({ type: "ROUTE_SINK_UNAVAILABLE", tabId })
    .catch(() => {});
}

function setSink(tabId, sinkId) {
  const route = routes.get(tabId);
  if (!route) return;
  route.sinkId = sinkId;
  route.ctx.setSinkId(sinkId).catch(() => {
    // A newer pick may already have replaced this one.
    if (route.sinkId === sinkId) resetSink(tabId, route);
  });
}

// Labels and real IDs need mic permission for the extension's origin,
// granted once on setup.html.
async function listOutputs() {
  const all = await navigator.mediaDevices.enumerateDevices();
  const outputs = all.filter((d) => d.kind === "audiooutput");
  return {
    granted: outputs.some((d) => d.label),
    devices: outputs.map((d) => ({ deviceId: d.deviceId, label: d.label })),
  };
}

// A routed device was unplugged: fall back to the default device rather
// than silently playing nowhere.
navigator.mediaDevices.addEventListener("devicechange", async () => {
  const { devices } = await listOutputs();
  routes.forEach((route, tabId) => {
    if (route.sinkId && !devices.some((d) => d.deviceId === route.sinkId)) {
      resetSink(tabId, route);
    }
  });
});

// runtime.sendMessage reaches every extension page, so this also sees the
// popup's and content scripts' messages to background. Never respond to
// those, or this document's reply could beat background's.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {
    case "OFFSCREEN_START":
      start(msg).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: e?.message || e?.name }),
      );
      return true;
    case "OFFSCREEN_SET_GAIN": {
      const route = routes.get(msg.tabId);
      if (route) route.gain.gain.value = msg.gain;
      return false;
    }
    case "OFFSCREEN_SET_SINK":
      setSink(msg.tabId, msg.sinkId);
      return false;
    case "OFFSCREEN_STOP":
      stop(msg.tabId);
      return false;
    case "OFFSCREEN_GET_DEVICES":
      listOutputs().then(sendResponse, () =>
        sendResponse({ granted: false, devices: [] }),
      );
      return true;
  }
  return false;
});
