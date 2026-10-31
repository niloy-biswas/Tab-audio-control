// Mock harness for content.js's SET_ROUTED flag. Usage: node tests/content-test.js [path/to/content.js]
const fs = require("fs");
const assert = require("assert/strict");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "..", "content.js"), "utf8");

function makeEl() {
  const el = { l: {}, _v: 1, sinkId: "", sinkCalls: [] };
  Object.defineProperty(el, "volume", {
    get() { return this._v; },
    set(v) {
      if (v < 0 || v > 1) throw new RangeError("IndexSizeError: volume out of range");
      const changed = v !== this._v; this._v = v;
      if (changed) queueMicrotask(() => this.l.volumechange?.());
    },
  });
  el.addEventListener = (t, f) => { el.l[t] = f; };
  el.setSinkId = async (id) => { el.sinkCalls.push(id); el.sinkId = id; };
  return el;
}

function boot(readyResponse) {
  const sent = [];
  let onMsg;
  const winListeners = {};
  const el = makeEl();
  const window = {
    addEventListener: (t, f) => { (winListeners[t] ??= []).push(f); },
    postMessage() {},
  };
  window.self = window; window.top = window;
  const document = {
    readyState: "complete",
    documentElement: {},
    querySelectorAll: (sel) => (sel === "audio, video" ? [el] : []),
    addEventListener() {},
  };
  const chrome = { runtime: {
    id: "ext",
    sendMessage: (m) => { sent.push(m); return Promise.resolve(m.type === "CONTENT_READY" ? readyResponse : undefined); },
    onMessage: { addListener: (f) => (onMsg = f) },
  }};
  class MutationObserver { observe() {} disconnect() {} }
  const navigator = { mediaDevices: { addEventListener() {}, removeEventListener() {} } };
  let rescan = () => {};
  new Function("window", "document", "chrome", "MutationObserver", "navigator", "setInterval", "clearInterval", src)(
    window, document, chrome, MutationObserver, navigator, (f) => { rescan = f; return 0; }, () => {},
  );
  const userInput = () => winListeners.keydown.forEach((f) => f({ isTrusted: true, type: "keydown" }));
  const msg = (m) => new Promise((res) => onMsg(m, {}, res));
  return { el, sent, msg, userInput, rescan: () => rescan() };
}
const tick = () => new Promise((r) => setTimeout(r, 5));
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.log("FAIL", name, "\n   ", e.message); process.exitCode = 1; }
}

(async () => {
  await test("unrouted baseline: stored volume and sink applied, page drift reverted", async () => {
    const { el, sent } = boot({ volume: 0.4, micGain: 1, sinkId: "dev", routed: false });
    await tick();
    assert.equal(el.volume, 0.4); assert.equal(el.sinkId, "dev");
    el.volume = 1; // page code, no user input
    await tick();
    assert.equal(el.volume, 0.4);
    assert.ok(!sent.some((m) => m.type === "VOLUME_DRIFTED"));
  });

  await test("routed: 1s rescan leaves the page's own volume alone", async () => {
    const { el, msg, rescan } = boot({ volume: 0.4, micGain: 1, sinkId: "", routed: false });
    await tick();
    await msg({ type: "SET_ROUTED", routed: true });
    el.volume = 0.5; // e.g. YouTube's own slider
    await tick();
    rescan();
    await tick();
    assert.equal(el.volume, 0.5, "rescan must not snap it back to 1");
  });

  await test("unrouted: user-driven drift adopted and reported", async () => {
    const { el, sent, userInput } = boot({ volume: 0.4, micGain: 1, sinkId: "", routed: false });
    await tick();
    userInput(); el.volume = 0.6; await tick();
    assert.deepEqual(sent.filter((m) => m.type === "VOLUME_DRIFTED"), [{ type: "VOLUME_DRIFTED", volume: 0.6 }]);
  });

  await test("SET_ROUTED true: volume 1, sink reset, drift neither reverted nor reported", async () => {
    const { el, sent, msg, userInput } = boot({ volume: 0.4, micGain: 1, sinkId: "dev", routed: false });
    await tick();
    await msg({ type: "SET_ROUTED", routed: true });
    await tick();
    assert.equal(el.volume, 1); assert.equal(el.sinkId, "");
    el.volume = 0.3; await tick(); // page code
    assert.equal(el.volume, 0.3, "not reverted immediately");
    userInput(); el.volume = 0.2; await tick();
    assert.ok(!sent.some((m) => m.type === "VOLUME_DRIFTED"));
  });

  await test("unroute (SET_VOLUME then SET_ROUTED false) restores volume and in-page sink", async () => {
    const { el, msg } = boot({ volume: 1.5, micGain: 1, sinkId: "dev", routed: true });
    await tick();
    assert.equal(el.volume, 1, "routed at init: boost value never reaches el.volume");
    assert.equal(el.sinkId, "");
    await msg({ type: "SET_VOLUME", volume: 1 });
    assert.equal(el.volume, 1);
    await msg({ type: "SET_ROUTED", routed: false });
    await msg({ type: "SET_VOLUME", volume: 0.5 });
    await tick();
    assert.equal(el.volume, 0.5); assert.equal(el.sinkId, "dev");
  });

  console.log(`${passed} passed`);
})();
