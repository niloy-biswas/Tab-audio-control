// Mock harness for offscreen.js. Usage: node tests/offscreen-test.js [path/to/offscreen.js]
const fs = require("fs");
const assert = require("assert/strict");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "..", "offscreen.js"), "utf8");

const sent = [];
let onMsg, onDeviceChange;
let devices = [{ kind: "audiooutput", deviceId: "default", label: "Default" }, { kind: "audiooutput", deviceId: "bt", label: "Buds" }];
let gumImpl;
const contexts = [];
class Track {
  constructor() { this.l = {}; this.stopped = false; }
  addEventListener(t, f) { this.l[t] = f; }
  stop() { this.stopped = true; } // per spec, stop() does not fire "ended"
  end() { this.l.ended?.(); }
}
class AudioContext {
  constructor() { this.closed = false; this.sinkId = ""; this.destination = { name: "dest" }; this.failSink = null; contexts.push(this); }
  createGain() { const g = { gain: { value: 1 }, connect: (n) => { g.to = n; return n; } }; this.gainNode = g; return g; }
  createMediaStreamSource(stream) { const s = { stream, connect: (n) => { s.to = n; return n; } }; this.source = s; return s; }
  async setSinkId(id) { if (id === this.failSink) throw Object.assign(new Error("nf"), { name: "NotFoundError" }); this.sinkId = id; }
  async close() { this.closed = true; }
  addEventListener(t, f) { if (t === "error") this.onerror = f; }
}
const navigator = { mediaDevices: {
  getUserMedia: async (c) => gumImpl(c),
  enumerateDevices: async () => devices,
  addEventListener: (t, f) => { if (t === "devicechange") onDeviceChange = f; },
}};
const chrome = { runtime: {
  onMessage: { addListener: (f) => (onMsg = f) },
  sendMessage: async (m) => { sent.push(m); },
}};
new Function("chrome", "navigator", "AudioContext", src)(chrome, navigator, AudioContext);

const send = (msg) => new Promise((res) => {
  let responded = false;
  const r = onMsg(msg, {}, (v) => { responded = true; res(v); });
  if (r !== true) setTimeout(() => res(responded ? "RESPONDED_SYNC" : "NO_RESPONSE"), 0);
});
const tick = () => new Promise((r) => setTimeout(r, 5));
let passed = 0;
async function test(name, fn) {
  sent.length = 0;
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.log("FAIL", name, "\n   ", e.message); process.exitCode = 1; }
}

(async () => {
  let lastTrack, lastConstraints;
  gumImpl = (c) => { lastConstraints = c; lastTrack = new Track(); const t = lastTrack; return { getTracks: () => [t], getAudioTracks: () => [t] }; };

  await test("ignores non-OFFSCREEN messages without responding", async () => {
    for (const type of ["POPUP_SET_VOLUME", "CONTENT_READY", "POPUP_GET_DEVICES", "GET_ALL_ROUTES", "ROUTE_ENDED"]) {
      assert.equal(await send({ type, tabId: 1 }), "NO_RESPONSE", type);
    }
  });

  await test("START builds source -> gain -> destination with tab constraints", async () => {
    assert.deepEqual(await send({ type: "OFFSCREEN_START", tabId: 1, streamId: "s1", gain: 0.5 }), { ok: true });
    assert.deepEqual(lastConstraints, { audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: "s1" } } });
    const ctx = contexts.at(-1);
    assert.equal(ctx.gainNode.gain.value, 0.5);
    assert.equal(ctx.source.to, ctx.gainNode);
    assert.equal(ctx.gainNode.to, ctx.destination);
  });

  await test("SET_GAIN and SET_SINK apply to that tab's context", async () => {
    const ctx = contexts.at(-1);
    assert.equal(await send({ type: "OFFSCREEN_SET_GAIN", tabId: 1, gain: 1.8 }), "NO_RESPONSE");
    assert.equal(ctx.gainNode.gain.value, 1.8);
    await send({ type: "OFFSCREEN_SET_SINK", tabId: 1, sinkId: "bt" });
    await tick();
    assert.equal(ctx.sinkId, "bt");
    assert.deepEqual(sent, []);
  });

  await test("one AudioContext per tab", async () => {
    await send({ type: "OFFSCREEN_START", tabId: 2, streamId: "s2", gain: 1 });
    assert.notEqual(contexts.at(-1), contexts.at(-2));
    await send({ type: "OFFSCREEN_SET_GAIN", tabId: 2, gain: 0.3 });
    assert.equal(contexts.at(-2).gainNode.gain.value, 1.8);
  });

  await test("GET_DEVICES lists outputs from the extension origin", async () => {
    assert.deepEqual(await send({ type: "OFFSCREEN_GET_DEVICES" }), {
      granted: true,
      devices: [{ deviceId: "default", label: "Default" }, { deviceId: "bt", label: "Buds" }],
    });
  });

  await test("setSinkId rejection falls back to default and reports", async () => {
    const ctx = contexts.at(-1); // tab 2
    ctx.failSink = "gone";
    await send({ type: "OFFSCREEN_SET_SINK", tabId: 2, sinkId: "gone" });
    await tick();
    assert.equal(ctx.sinkId, "");
    assert.deepEqual(sent, [{ type: "ROUTE_SINK_UNAVAILABLE", tabId: 2 }]);
  });

  await test("devicechange: unplugged routed device falls back, others untouched", async () => {
    const ctx1 = contexts.at(-2); // tab 1 on bt
    devices = devices.filter((d) => d.deviceId !== "bt");
    await onDeviceChange();
    await tick();
    assert.equal(ctx1.sinkId, "");
    assert.deepEqual(sent, [{ type: "ROUTE_SINK_UNAVAILABLE", tabId: 1 }]);
  });

  await test("STOP ends tracks, closes context, no ROUTE_ENDED", async () => {
    const ctx = contexts.at(-1); const track = lastTrack;
    await send({ type: "OFFSCREEN_STOP", tabId: 2 });
    assert.ok(track.stopped); assert.ok(ctx.closed);
    track.end(); // even if it fired
    assert.deepEqual(sent, []);
  });

  await test("captured track ending sends ROUTE_ENDED and cleans up", async () => {
    await send({ type: "OFFSCREEN_START", tabId: 3, streamId: "s3", gain: 1 });
    const ctx = contexts.at(-1); const track = lastTrack;
    track.end();
    await tick();
    assert.ok(ctx.closed);
    assert.deepEqual(sent, [{ type: "ROUTE_ENDED", tabId: 3 }]);
  });

  await test("re-START for same tab replaces old capture silently", async () => {
    await send({ type: "OFFSCREEN_START", tabId: 4, streamId: "a", gain: 1 });
    const oldCtx = contexts.at(-1); const oldTrack = lastTrack;
    await send({ type: "OFFSCREEN_START", tabId: 4, streamId: "b", gain: 1 });
    assert.ok(oldCtx.closed); assert.ok(oldTrack.stopped);
    oldTrack.end();
    assert.deepEqual(sent, []);
  });

  await test("getUserMedia failure is reported with its message", async () => {
    gumImpl = async () => { throw Object.assign(new Error("Error starting tab capture"), { name: "AbortError" }); };
    assert.deepEqual(await send({ type: "OFFSCREEN_START", tabId: 5, streamId: "x", gain: 1 }), { ok: false, error: "Error starting tab capture" });
  });

  await test("device error rebuilds the graph and retries the chosen sink", async () => {
    gumImpl = (c) => { lastConstraints = c; lastTrack = new Track(); const t = lastTrack; return { getTracks: () => [t], getAudioTracks: () => [t] }; };
    await send({ type: "OFFSCREEN_START", tabId: 7, streamId: "s7", gain: 1.4 });
    await send({ type: "OFFSCREEN_SET_SINK", tabId: 7, sinkId: "bt" });
    await tick();
    const first = contexts.at(-1);
    first.onerror();
    await tick();
    const second = contexts.at(-1);
    assert.notEqual(second, first, "new context");
    assert.equal(first.closed, true);
    assert.equal(second.gainNode.gain.value, 1.4, "gain carried over");
    assert.equal(second.source.stream, first.source.stream, "same capture stream");
    assert.equal(second.sinkId, "bt", "chosen device retried");
    assert.ok(!sent.some((m) => m.type === "ROUTE_ENDED"));
  });

  await test("second device error within the window hands the tab back", async () => {
    const ctx = contexts.at(-1);
    const track = lastTrack;
    ctx.onerror();
    await tick();
    assert.equal(track.stopped, true, "capture stopped so the tab plays normally");
    assert.deepEqual(sent.filter((m) => m.type === "ROUTE_ENDED"), [{ type: "ROUTE_ENDED", tabId: 7 }]);
  });

  await test("error from a stale context is ignored", async () => {
    await send({ type: "OFFSCREEN_START", tabId: 8, streamId: "s8", gain: 1 });
    const first = contexts.at(-1);
    first.onerror(); await tick();
    const count = contexts.length;
    first.onerror(); await tick(); // old context fires again
    assert.equal(contexts.length, count, "no extra rebuild");
    assert.ok(!sent.some((m) => m.type === "ROUTE_ENDED"));
  });

  console.log(`${passed} passed`);
})();
