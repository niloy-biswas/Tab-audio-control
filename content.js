(() => {
  // Background also injects this into already-open tabs on install/reload,
  // so a tab can receive it twice. Bail only if a *live* instance exists —
  // an orphan from before the reload reports itself dead and tears down.
  if (window.__tacContentAlive?.()) return;
  let dead = false;
  function contextLost() {
    return dead || !chrome.runtime?.id;
  }
  window.__tacContentAlive = () => !contextLost();

  let currentVolume = 1;
  let currentSinkId = "";
  const hookedEls = new WeakSet();
  const observedRoots = new WeakSet();
  let observer;

  // chrome.runtime.sendMessage can throw *synchronously* (not just reject)
  // once this tab's content script context is invalidated — e.g. the
  // extension was reloaded but this tab hasn't been refreshed yet. A plain
  // .catch(() => {}) doesn't guard against that, since the throw happens
  // before a promise is even returned.
  function notifyBackground(msg) {
    try {
      chrome.runtime.sendMessage(msg).catch(() => {});
    } catch (e) {
      // Context invalidated — nothing to do until this tab reloads.
    }
  }

  // el -> sinkId that setSinkId already rejected for it, so the 1s scan
  // doesn't retry a doomed call forever.
  const failedSinks = new WeakMap();

  function applySink(el) {
    if (typeof el.setSinkId !== "function") return;
    if (el.sinkId === currentSinkId) return;
    if (failedSinks.get(el) === currentSinkId) return;
    const target = currentSinkId;
    el.setSinkId(target).catch((e) => {
      failedSinks.set(el, target);
      // Device IDs are origin-scoped, so a cross-origin sub-frame can't
      // resolve the ID the top frame enumerated. Only the top frame's
      // NotFoundError means the device is really gone; anything else
      // (policy, autoplay, sub-frame ID mismatch) must not reset the tab.
      if (
        window.self === window.top &&
        e?.name === "NotFoundError" &&
        currentSinkId === target
      ) {
        resetSinkToDefault();
      }
    });
  }

  function apply(el) {
    el.volume = currentVolume;
    applySink(el);
  }

  function hook(el) {
    apply(el);
    if (hookedEls.has(el)) return;
    hookedEls.add(el);
    // The page's own volume control (e.g. YouTube's slider) touches this
    // same .volume property. Adopt any drift as the new current value and
    // push it back to the popup, instead of fighting it — that way either
    // control can drive the other instead of conflicting.
    el.addEventListener("volumechange", () => {
      // An orphan must not revert the live instance's change before its
      // next scan notices and tears down.
      if (contextLost()) return;
      if (Math.abs(el.volume - currentVolume) > 0.001) {
        currentVolume = el.volume;
        document
          .querySelectorAll("audio, video")
          .forEach((other) => other !== el && apply(other));
        notifyBackground({ type: "VOLUME_DRIFTED", volume: currentVolume });
      }
    });
  }

  // Many players (YouTube's ytd-player included) put the real <video> inside
  // a shadow root, which plain querySelectorAll can't see into. Walk down
  // through every open shadow root too, and start observing each one we
  // find so later mutations inside it are picked up as well.
  function collectMedia(root, out) {
    root.querySelectorAll("audio, video").forEach((el) => out.push(el));
    root.querySelectorAll("*").forEach((el) => {
      const sr = el.shadowRoot;
      if (!sr) return;
      if (!observedRoots.has(sr)) {
        observedRoots.add(sr);
        observer.observe(sr, { childList: true, subtree: true });
      }
      collectMedia(sr, out);
    });
  }

  // Extension was reloaded under this tab: stop touching media so this stale
  // instance doesn't fight the freshly injected one (e.g. resetting sinkId).
  function teardown() {
    dead = true;
    observer.disconnect();
    clearInterval(scanTimer);
    navigator.mediaDevices?.removeEventListener(
      "devicechange",
      enumerateAndReport,
    );
    hidePicker();
  }

  function scan() {
    if (contextLost()) return teardown();
    const media = [];
    collectMedia(document, media);
    media.forEach(hook);
  }

  function setVolume(v) {
    currentVolume = v;
    const media = [];
    collectMedia(document, media);
    media.forEach(apply);
  }

  function setSinkId(id) {
    currentSinkId = id;
    const media = [];
    collectMedia(document, media);
    media.forEach(apply);
  }

  // The routed device is gone — fall back to system default and tell
  // background so the popup and future CONTENT_READY responses agree.
  function resetSinkToDefault() {
    setSinkId("");
    notifyBackground({ type: "SINK_DEVICE_UNAVAILABLE" });
  }

  async function enumerateAndReport() {
    // Some sites disallow the `speaker-selection` Permissions-Policy feature
    // outright, in which case selectAudioOutput doesn't exist at all (not
    // just rejects) — nothing the on-page picker can do about that.
    const supported =
      typeof navigator.mediaDevices?.selectAudioOutput === "function";
    if (!navigator.mediaDevices?.enumerateDevices) {
      return { granted: false, devices: [], supported };
    }
    const all = await navigator.mediaDevices.enumerateDevices();
    const outputs = all.filter((d) => d.kind === "audiooutput");
    const result = {
      granted: outputs.some((d) => d.label),
      devices: outputs.map((d) => ({ deviceId: d.deviceId, label: d.label })),
      supported,
    };
    notifyBackground({ type: "SINK_DEVICES_UPDATED", ...result });
    // The device we're currently routed to disappeared (unplugged) — fall
    // back to system default rather than silently going nowhere.
    if (
      currentSinkId &&
      !result.devices.some((d) => d.deviceId === currentSinkId)
    ) {
      resetSinkToDefault();
    }
    return result;
  }

  // On-page trigger for navigator.mediaDevices.selectAudioOutput(), which
  // requires a real click in this exact page — a popup click doesn't count.
  // Own shadow root so host-page CSS can't reach in or be reached.
  let pickerHost = null;
  let pickerHideTimer = null;

  function ensurePicker() {
    if (pickerHost) return pickerHost;
    pickerHost = document.createElement("div");
    pickerHost.style.all = "initial";
    pickerHost.style.position = "fixed";
    pickerHost.style.zIndex = "2147483647";
    pickerHost.style.bottom = "16px";
    pickerHost.style.right = "16px";
    const shadow = pickerHost.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    style.textContent = `
      button {
        font: 600 13px -apple-system, system-ui, sans-serif;
        padding: 8px 16px;
        border-radius: 999px;
        border: none;
        background: #007aff;
        color: #fff;
        box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
        cursor: pointer;
      }
    `;
    const btn = document.createElement("button");
    btn.textContent = "Choose audio output…";
    btn.addEventListener("click", () => {
      navigator.mediaDevices
        .selectAudioOutput()
        .then(() => enumerateAndReport())
        .catch(() => {
          // Dismissed, or NotAllowedError/AbortError — no retry loop.
        })
        .finally(hidePicker);
    });
    shadow.append(style, btn);
    (document.documentElement || document.body).appendChild(pickerHost);
    return pickerHost;
  }

  function hidePicker() {
    if (pickerHost) pickerHost.style.display = "none";
    if (pickerHideTimer) clearTimeout(pickerHideTimer);
  }

  function showPicker() {
    if (typeof navigator.mediaDevices?.selectAudioOutput !== "function") {
      return;
    }
    const host = ensurePicker();
    host.style.display = "block";
    if (pickerHideTimer) clearTimeout(pickerHideTimer);
    pickerHideTimer = setTimeout(hidePicker, 8000);
  }

  observer = new MutationObserver(scan);
  let scanTimer;

  function start() {
    scan();
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
    // Belt-and-braces: a shadow root can be attached with no light-DOM
    // mutation we'd otherwise catch, so also re-scan on a short interval.
    scanTimer = setInterval(scan, 1000);

    // Device enumeration/permission flow is a single per-tab concern —
    // only the top frame drives it, sub-frames just keep routing audio.
    if (window.self === window.top && navigator.mediaDevices) {
      navigator.mediaDevices.addEventListener(
        "devicechange",
        enumerateAndReport,
      );
    }
  }

  async function init() {
    let micGain = 1;
    try {
      const res = await chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      if (res && typeof res.volume === "number") currentVolume = res.volume;
      if (res && typeof res.micGain === "number") micGain = res.micGain;
      if (res && typeof res.sinkId === "string") currentSinkId = res.sinkId;
    } catch (e) {
      // Background not reachable (e.g. extension reloading) — default to 1.
    }
    // Seed the MAIN-world mic hook even when micGain is the default 1, so
    // its internal currentGain always matches what background thinks it is.
    window.postMessage({ __tac: true, type: "SET_MIC_GAIN", gain: micGain }, "*");
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", start);
    } else {
      start();
    }
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === "SET_VOLUME") {
      setVolume(msg.volume);
      sendResponse({ ok: true });
    } else if (msg.type === "SET_MIC_GAIN") {
      window.postMessage(
        { __tac: true, type: "SET_MIC_GAIN", gain: msg.gain },
        "*",
      );
      sendResponse({ ok: true });
    } else if (msg.type === "SET_SINK_ID") {
      setSinkId(msg.sinkId);
      sendResponse({ ok: true });
    } else if (msg.type === "REQUEST_DEVICE_LIST") {
      // Only the top frame owns the picker/permission flow — a sub-frame
      // staying silent here lets the top frame's response be the one that
      // reaches background, instead of racing multiple frame responses.
      if (window.self !== window.top) return false;
      enumerateAndReport().then(sendResponse);
      return true;
    } else if (msg.type === "SHOW_SINK_PICKER") {
      if (window.self !== window.top) return false;
      showPicker();
      sendResponse({ ok: true });
    }
  });

  // Bridge for the MAIN-world mic-gain-hook.js, which has no chrome.* access.
  window.addEventListener("message", (event) => {
    if (event.source !== window || !event.data?.__tac) return;
    if (
      event.data.type === "MIC_CAPTURE_STARTED" ||
      event.data.type === "MIC_CAPTURE_STOPPED"
    ) {
      notifyBackground({ type: event.data.type });
    }
  });

  init();
})();
