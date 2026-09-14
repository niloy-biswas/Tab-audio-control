(() => {
  let currentVolume = 1;
  const hookedEls = new WeakSet();
  const observedRoots = new WeakSet();
  let observer;

  function apply(el) {
    el.volume = currentVolume;
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
      if (Math.abs(el.volume - currentVolume) > 0.001) {
        currentVolume = el.volume;
        document
          .querySelectorAll("audio, video")
          .forEach((other) => other !== el && apply(other));
        chrome.runtime
          .sendMessage({ type: "VOLUME_DRIFTED", volume: currentVolume })
          .catch(() => {});
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

  function scan() {
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

  observer = new MutationObserver(scan);

  function start() {
    scan();
    observer.observe(document.documentElement || document, {
      childList: true,
      subtree: true,
    });
    // Belt-and-braces: a shadow root can be attached with no light-DOM
    // mutation we'd otherwise catch, so also re-scan on a short interval.
    setInterval(scan, 1000);
  }

  async function init() {
    try {
      const res = await chrome.runtime.sendMessage({ type: "CONTENT_READY" });
      if (res && typeof res.volume === "number") currentVolume = res.volume;
    } catch (e) {
      // Background not reachable (e.g. extension reloading) — default to 1.
    }
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
    }
  });

  init();
})();
