// Mock harness for background.js. Usage: node tests/bg-test.js [path/to/background.js]
// (the path argument lets you point it at a modified copy to check a test can fail)
const fs = require("fs");
const path = require("path");
const assert = require("assert/strict");
const src = fs.readFileSync(process.argv[2] ?? path.join(__dirname, "..", "background.js"), "utf8");

let store = {};
let log; // every outbound call, in order
let offscreenExists = false;
let createCount = 0;
let streamIdImpl;
let offscreenReply; // (msg) => response for runtime.sendMessage to offscreen
let onRemoved;

function boot() {
  let onMsg;
  const chrome = {
    storage: { session: {
      get: async (k) => ({ [k]: store[k] && JSON.parse(JSON.stringify(store[k])) }),
      set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); },
    }},
    runtime: {
      onMessage: { addListener: (f) => (onMsg = f) },
      onInstalled: { addListener() {} },
      getContexts: async ({ contextTypes }) => {
        assert.deepEqual(contextTypes, ["OFFSCREEN_DOCUMENT"]);
        return offscreenExists ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : [];
      },
      sendMessage: async (msg) => {
        log.push(["offscreen", msg]);
        if (!offscreenExists) throw new Error("Could not establish connection. Receiving end does not exist.");
        return offscreenReply(msg);
      },
    },
    offscreen: {
      createDocument: async (opts) => {
        createCount++;
        log.push(["createDocument", opts]);
        await new Promise((r) => setTimeout(r, 5));
        offscreenExists = true;
      },
    },
    tabCapture: {
      getMediaStreamId: async (opts) => { log.push(["getMediaStreamId", opts]); return streamIdImpl(opts); },
    },
    tabs: {
      sendMessage: async (tabId, msg) => { log.push(["tab", tabId, msg]); return { ok: true }; },
      query: async () => [],
      onRemoved: { addListener: (f) => (onRemoved = f) },
    },
    scripting: { executeScript: async () => {} },
  };
  new Function("chrome", src)(chrome);
  return (msg, sender = {}) =>
    new Promise((res) => {
      const r = onMsg(msg, sender, res);
      if (r !== true) res("NOT_ASYNC");
    });
}

const tick = () => new Promise((r) => setTimeout(r, 10));
const reset = () => { log = []; };
const offscreenMsgs = () => log.filter((e) => e[0] === "offscreen").map((e) => e[1]);
const tabMsgs = (id) => log.filter((e) => e[0] === "tab" && e[1] === id).map((e) => e[2]);
process.on("unhandledRejection", (e) => { console.log("UNHANDLED REJECTION", e?.message); process.exitCode = 1; });
let passed = 0;
async function test(name, fn) {
  reset();
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.log("FAIL", name, "\n   ", e.message); process.exitCode = 1; }
}

(async () => {
  streamIdImpl = ({ targetTabId }) => `stream-${targetTabId}`;
  offscreenReply = (msg) => {
    if (msg.type === "OFFSCREEN_START") return { ok: true };
    if (msg.type === "OFFSCREEN_GET_DEVICES") return { granted: true, devices: [{ deviceId: "bt", label: "Buds" }] };
    return undefined;
  };
  let send = boot();

  await test("non-routed: CONTENT_READY defaults, routed false", async () => {
    assert.deepEqual(await send({ type: "CONTENT_READY" }, { tab: { id: 3 } }),
      { volume: 1, micGain: 1, sinkId: "", routed: false });
  });

  await test("non-routed: POPUP_SET_VOLUME goes to content script only", async () => {
    assert.deepEqual(await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 0.4 }), { ok: true });
    assert.deepEqual(tabMsgs(3), [{ type: "SET_VOLUME", volume: 0.4 }]);
    assert.equal(offscreenMsgs().length, 0);
    assert.deepEqual(await send({ type: "GET_ALL_VOLUMES" }), { 3: 0.4 });
  });

  await test("non-routed: volume above 1 is clamped (stale 200% row)", async () => {
    await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 1.5 });
    assert.deepEqual(tabMsgs(3), [{ type: "SET_VOLUME", volume: 1 }]);
    await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 0.4 });
  });

  await test("non-routed: sink, devices, drift unchanged", async () => {
    await send({ type: "POPUP_SET_SINK_ID", tabId: 3, sinkId: "site-dev" });
    assert.deepEqual(tabMsgs(3), [{ type: "SET_SINK_ID", sinkId: "site-dev" }]);
    reset();
    await send({ type: "POPUP_GET_DEVICES", tabId: 3 });
    assert.deepEqual(tabMsgs(3), [{ type: "REQUEST_DEVICE_LIST" }]);
    assert.equal(await send({ type: "VOLUME_DRIFTED", volume: 0.5 }, { tab: { id: 3 } }), undefined);
    assert.deepEqual(await send({ type: "GET_ALL_VOLUMES" }), { 3: 0.5 });
    assert.equal(offscreenMsgs().length, 0);
  });

  await test("route: stream id -> offscreen created (USER_MEDIA) -> START with stored gain -> SET_ROUTED", async () => {
    const res = await send({ type: "POPUP_ROUTE_TAB", tabId: 3 });
    assert.deepEqual(res, { ok: true });
    assert.deepEqual(log[0], ["getMediaStreamId", { targetTabId: 3 }]);
    assert.equal(log[1][0], "createDocument");
    assert.deepEqual(log[1][1].reasons, ["USER_MEDIA"]);
    assert.equal(log[1][1].url, "offscreen.html");
    assert.deepEqual(offscreenMsgs(), [{ type: "OFFSCREEN_START", tabId: 3, streamId: "stream-3", gain: 0.5 }]);
    assert.deepEqual(tabMsgs(3), [{ type: "SET_ROUTED", routed: true }]);
    assert.deepEqual(await send({ type: "GET_ALL_ROUTES" }), { 3: { sinkId: "" } });
  });

  await test("routed: volume (incl. boost) and sink go to offscreen, not content", async () => {
    await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 1.5 });
    await send({ type: "POPUP_SET_SINK_ID", tabId: 3, sinkId: "bt" });
    assert.deepEqual(offscreenMsgs(), [
      { type: "OFFSCREEN_SET_GAIN", tabId: 3, gain: 1.5 },
      { type: "OFFSCREEN_SET_SINK", tabId: 3, sinkId: "bt" },
    ]);
    assert.deepEqual(tabMsgs(3), []);
    assert.deepEqual(await send({ type: "GET_ALL_SINKS" }), { 3: "site-dev" }, "in-page sink untouched");
    assert.deepEqual(await send({ type: "GET_ALL_ROUTES" }), { 3: { sinkId: "bt" } });
    assert.deepEqual(await send({ type: "GET_ALL_VOLUMES" }), { 3: 1.5 });
  });

  await test("routed: POPUP_GET_DEVICES asks offscreen", async () => {
    const res = await send({ type: "POPUP_GET_DEVICES", tabId: 3 });
    assert.deepEqual(res, { granted: true, devices: [{ deviceId: "bt", label: "Buds" }] });
    assert.deepEqual(offscreenMsgs(), [{ type: "OFFSCREEN_GET_DEVICES" }]);
    assert.deepEqual(tabMsgs(3), []);
  });

  await test("routed: VOLUME_DRIFTED ignored, CONTENT_READY says routed", async () => {
    await send({ type: "VOLUME_DRIFTED", volume: 1 }, { tab: { id: 3 } });
    assert.deepEqual(await send({ type: "GET_ALL_VOLUMES" }), { 3: 1.5 });
    assert.deepEqual(await send({ type: "CONTENT_READY" }, { tab: { id: 3 } }),
      { volume: 1.5, micGain: 1, sinkId: "site-dev", routed: true });
  });

  await test("routed state survives worker restart; offscreen not recreated", async () => {
    await tick();
    send = boot();
    assert.deepEqual(await send({ type: "GET_ALL_ROUTES" }), { 3: { sinkId: "bt" } });
    await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 1.2 });
    assert.deepEqual(offscreenMsgs(), [{ type: "OFFSCREEN_SET_GAIN", tabId: 3, gain: 1.2 }]);
    assert.deepEqual(tabMsgs(3), []);
    reset();
    await send({ type: "POPUP_ROUTE_TAB", tabId: 9 });
    assert.equal(log.filter((e) => e[0] === "createDocument").length, 0);
  });

  await test("ROUTE_SINK_UNAVAILABLE resets the routed sink only", async () => {
    await send({ type: "ROUTE_SINK_UNAVAILABLE", tabId: 3 });
    assert.deepEqual((await send({ type: "GET_ALL_ROUTES" }))[3], { sinkId: "" });
    assert.deepEqual((await send({ type: "GET_ALL_SINKS" }))[3], "site-dev");
  });

  await test("unroute: STOP, SET_VOLUME (clamped) before SET_ROUTED false; back to content", async () => {
    assert.deepEqual(await send({ type: "POPUP_UNROUTE_TAB", tabId: 3 }), { ok: true });
    assert.deepEqual(offscreenMsgs(), [{ type: "OFFSCREEN_STOP", tabId: 3 }]);
    assert.deepEqual(tabMsgs(3), [
      { type: "SET_VOLUME", volume: 1 },
      { type: "SET_ROUTED", routed: false },
    ]);
    assert.equal((await send({ type: "GET_ALL_ROUTES" }))[3], undefined);
    assert.equal((await send({ type: "GET_ALL_VOLUMES" }))[3], 1);
    assert.deepEqual(await send({ type: "CONTENT_READY" }, { tab: { id: 3 } }),
      { volume: 1, micGain: 1, sinkId: "site-dev", routed: false });
    reset();
    await send({ type: "POPUP_SET_VOLUME", tabId: 3, volume: 0.7 });
    await send({ type: "POPUP_SET_SINK_ID", tabId: 3, sinkId: "site-dev2" });
    assert.deepEqual(tabMsgs(3), [
      { type: "SET_VOLUME", volume: 0.7 },
      { type: "SET_SINK_ID", sinkId: "site-dev2" },
    ]);
    assert.equal(offscreenMsgs().length, 0);
  });

  await test("unroute keeps a sub-100% volume", async () => {
    await send({ type: "POPUP_ROUTE_TAB", tabId: 3 });
    reset();
    await send({ type: "POPUP_UNROUTE_TAB", tabId: 3 });
    assert.deepEqual(tabMsgs(3)[0], { type: "SET_VOLUME", volume: 0.7 });
  });

  await test("ROUTE_ENDED clears routed state and hands back to content", async () => {
    await send({ type: "POPUP_ROUTE_TAB", tabId: 3 });
    reset();
    assert.equal(await send({ type: "ROUTE_ENDED", tabId: 3 }), undefined);
    assert.equal((await send({ type: "GET_ALL_ROUTES" }))[3], undefined);
    assert.deepEqual(tabMsgs(3), [
      { type: "SET_VOLUME", volume: 0.7 },
      { type: "SET_ROUTED", routed: false },
    ]);
    assert.equal(offscreenMsgs().length, 0);
    reset();
    await send({ type: "ROUTE_ENDED", tabId: 3 }); // duplicate is a no-op
    assert.deepEqual(log, []);
  });

  await test("tabs.onRemoved stops capture and clears routed state", async () => {
    await send({ type: "POPUP_ROUTE_TAB", tabId: 4 });
    reset();
    await onRemoved(4);
    assert.deepEqual(offscreenMsgs(), [{ type: "OFFSCREEN_STOP", tabId: 4 }]);
    assert.equal((await send({ type: "GET_ALL_ROUTES" }))[4], undefined);
    reset();
    await onRemoved(5); // never routed: no STOP
    assert.equal(offscreenMsgs().length, 0);
  });

  await test("getMediaStreamId rejection is surfaced, no state change", async () => {
    streamIdImpl = () => { throw new Error("Extension has not been invoked for the current page"); };
    const res = await send({ type: "POPUP_ROUTE_TAB", tabId: 6 });
    assert.deepEqual(res, { ok: false, error: "Extension has not been invoked for the current page" });
    assert.equal((await send({ type: "GET_ALL_ROUTES" }))[6], undefined);
    assert.deepEqual(tabMsgs(6), []);
    streamIdImpl = ({ targetTabId }) => `stream-${targetTabId}`;
  });

  await test("offscreen START failure is surfaced, no state change", async () => {
    const prev = offscreenReply;
    offscreenReply = (m) => m.type === "OFFSCREEN_START" ? { ok: false, error: "Error starting tab capture" } : prev(m);
    const res = await send({ type: "POPUP_ROUTE_TAB", tabId: 6 });
    assert.deepEqual(res, { ok: false, error: "Error starting tab capture" });
    assert.equal((await send({ type: "GET_ALL_ROUTES" }))[6], undefined);
    assert.deepEqual(tabMsgs(6), []);
    offscreenReply = (m) => (m.type === "OFFSCREEN_START" ? undefined : prev(m));
    assert.deepEqual(await send({ type: "POPUP_ROUTE_TAB", tabId: 6 }), { ok: false, error: "Playback didn't start" });
    offscreenReply = prev;
  });

  await test("concurrent routes create the offscreen document once", async () => {
    store = {}; offscreenExists = false; createCount = 0;
    send = boot();
    const [a, b] = await Promise.all([
      send({ type: "POPUP_ROUTE_TAB", tabId: 11 }),
      send({ type: "POPUP_ROUTE_TAB", tabId: 12 }),
    ]);
    assert.deepEqual([a, b], [{ ok: true }, { ok: true }]);
    assert.equal(createCount, 1);
  });

  await test("browser restart (session cleared): nothing routed", async () => {
    store = {}; offscreenExists = false;
    send = boot();
    assert.deepEqual(await send({ type: "GET_ALL_ROUTES" }), {});
    assert.deepEqual(await send({ type: "CONTENT_READY" }, { tab: { id: 11 } }),
      { volume: 1, micGain: 1, sinkId: "", routed: false });
  });

  // Folded in from the original restart check: unrouted state (volume, mic
  // gain, active-mic tabs) must survive the worker being stopped too.
  await test("unrouted state survives worker restart; fire-and-forget settles", async () => {
    store = {};
    send = boot();
    await send({ type: "POPUP_SET_VOLUME", tabId: 7, volume: 0.3 });
    await send({ type: "POPUP_SET_MIC_GAIN", gain: 0.5 });
    // Handlers that don't reply must still close the channel (resolves undefined).
    assert.equal(await send({ type: "MIC_CAPTURE_STARTED" }, { tab: { id: 7 } }), undefined);
    await tick();
    send = boot();
    assert.deepEqual(await send({ type: "CONTENT_READY" }, { tab: { id: 7 } }),
      { volume: 0.3, micGain: 0.5, sinkId: "", routed: false });
    assert.deepEqual(await send({ type: "GET_ALL_VOLUMES" }), { 7: 0.3 });
    assert.deepEqual(await send({ type: "GET_ALL_MIC_STATE" }), { gain: 0.5, active: [7] });
  });

  console.log(`${passed} passed`);
})();
