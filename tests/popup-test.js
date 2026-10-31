// Minimal DOM mock for popup.js routing UI. Usage: node tests/popup-test.js [path/to/popup.js]
const fs = require("fs");
const assert = require("assert/strict");
const src = fs.readFileSync(process.argv[2] ?? require("path").join(__dirname, "..", "popup.js"), "utf8");

class El {
  constructor(tag) { this.tag = tag; this.children = []; this.l = {}; this.style = { setProperty: (k, v) => (this.style[k] = v) }; this.dataset = {}; this.textContent = ""; }
  append(...c) { this.children.push(...c); }
  appendChild(c) { this.children.push(c); return c; }
  set innerHTML(_) { this.children = []; }
  get childElementCount() { return this.children.length; }
  addEventListener(t, f) { this.l[t] = f; }
  replaceWith() {}
  // <select> semantics
  get value() { if (this.tag !== "select") return this._value; return this.children[this.selectedIndex]?.value ?? ""; }
  set value(v) { if (this.tag !== "select") { this._value = v; return; } this.selectedIndex = this.children.findIndex((o) => o.value === v); }
  find(pred) { if (pred(this)) return this; for (const c of this.children) { const r = c.find?.(pred); if (r) return r; } }
}
function setup({ tabs, routes = {}, devices, activeId, micState = "granted", routeReply = { ok: true } }) {
  const sent = [], created = [], updates = [];
  const byId = { tabList: new El("div"), empty: new El("div"), micRow: new El("div") };
  const document = { getElementById: (id) => byId[id], createElement: (t) => new El(t) };
  const chrome = {
    runtime: { sendMessage: async (m) => {
      sent.push(m);
      switch (m.type) {
        case "GET_ALL_VOLUMES": return {};
        case "GET_ALL_MIC_STATE": return { gain: 1, active: [] };
        case "GET_ALL_SINKS": return {};
        case "GET_ALL_ROUTES": return routes;
        case "POPUP_GET_MIC_GAIN": return { gain: 1 };
        case "POPUP_GET_DEVICES": return devices(m.tabId);
        case "POPUP_ROUTE_TAB": return routeReply;
        default: return { ok: true };
      }
    }},
    tabs: {
      query: async (q) => (q.active ? tabs.filter((t) => t.id === activeId) : tabs),
      create: (o) => created.push(o),
      update: (id, o) => updates.push(["tab", id, o]),
      onUpdated: { addListener() {} }, onRemoved: { addListener() {} },
    },
    windows: { update: (id, o) => updates.push(["window", id, o]) },
  };
  const navigator = { permissions: { query: async () => ({ state: micState }) } };
  new Function("document", "chrome", "navigator", src)(document, chrome, navigator);
  return { list: byId.tabList, sent, created, updates };
}
const tick = () => new Promise((r) => setTimeout(r, 10));
const rowOf = (list, id) => list.children.find((r) => r.dataset.tabId === id);
const text = (el) => el.find((e) => e.className === "grant-hint")?.textContent;
let passed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok  ", name); }
  catch (e) { console.log("FAIL", name, "\n   ", e.message); process.exitCode = 1; }
}
const noMic = () => ({ granted: false, devices: [], supported: false });

(async () => {
  const yt = { id: 1, audible: true, title: "YT", windowId: 10 };
  const fb = { id: 2, audible: true, title: "FB", windowId: 10 };

  await test("no site mic -> Route this tab button; site mic -> in-page select unchanged", async () => {
    const { list } = setup({ tabs: [yt, fb], activeId: 1, devices: (id) => id === 2
      ? { granted: true, devices: [{ deviceId: "a", label: "A" }], supported: false } : noMic() });
    await tick();
    assert.equal(rowOf(list, 1).find((e) => e.tag === "button")?.textContent, "Route this tab");
    const sel = rowOf(list, 2).find((e) => e.tag === "select");
    assert.deepEqual(sel.children.map((o) => o.textContent), ["System Default", "A"]);
    assert.equal(rowOf(list, 2).find((e) => e.tag === "input").max, "100");
  });

  await test("route active tab: sends POPUP_ROUTE_TAB, re-renders", async () => {
    const env = setup({ tabs: [yt], activeId: 1, devices: noMic });
    await tick();
    rowOf(env.list, 1).find((e) => e.tag === "button").l.click();
    await tick();
    assert.ok(env.sent.some((m) => m.type === "POPUP_ROUTE_TAB" && m.tabId === 1));
    assert.equal(env.sent.filter((m) => m.type === "GET_ALL_ROUTES").length, 2, "reloadRows ran");
  });

  await test("route failure shows the reason instead of doing nothing", async () => {
    const env = setup({ tabs: [yt], activeId: 1, devices: noMic, routeReply: { ok: false, error: "Chrome pages cannot be captured" } });
    await tick();
    rowOf(env.list, 1).find((e) => e.tag === "button").l.click();
    await tick();
    assert.equal(text(rowOf(env.list, 1)), "Couldn't route: Chrome pages cannot be captured");
  });

  await test("no extension mic permission -> opens setup.html, doesn't route", async () => {
    const env = setup({ tabs: [yt], activeId: 1, devices: noMic, micState: "prompt" });
    await tick();
    rowOf(env.list, 1).find((e) => e.tag === "button").l.click();
    await tick();
    assert.deepEqual(env.created, [{ url: "setup.html" }]);
    assert.ok(!env.sent.some((m) => m.type === "POPUP_ROUTE_TAB"));
  });

  await test("non-active tab -> focuses it with hint, doesn't route", async () => {
    const env = setup({ tabs: [yt, fb], activeId: 2, devices: noMic });
    await tick();
    rowOf(env.list, 1).find((e) => e.tag === "button").l.click();
    await tick();
    assert.deepEqual(env.updates, [["tab", 1, { active: true }], ["window", 10, { focused: true }]]);
    assert.equal(text(rowOf(env.list, 1)), "Open the popup again to route");
    assert.ok(!env.sent.some((m) => m.type === "POPUP_ROUTE_TAB"));
  });

  await test("routed row: 200% slider, extension devices, Stop routing", async () => {
    const env = setup({ tabs: [yt], activeId: 1, routes: { 1: { sinkId: "bt" } },
      devices: () => ({ granted: true, devices: [{ deviceId: "bt", label: "Buds" }] }) });
    await tick();
    const row = rowOf(env.list, 1);
    assert.equal(row.find((e) => e.tag === "input").max, "200");
    const sel = row.find((e) => e.tag === "select");
    assert.deepEqual(sel.children.map((o) => o.textContent), ["System Default", "Buds", "Stop routing"]);
    assert.equal(sel.value, "bt");
    sel.value = ""; sel.l.change();
    assert.deepEqual(env.sent.at(-1), { type: "POPUP_SET_SINK_ID", tabId: 1, sinkId: "" });
    sel.selectedIndex = 2; sel.l.change();
    await tick();
    assert.equal(sel.value, "", "action restores selection");
    assert.ok(env.sent.some((m) => m.type === "POPUP_UNROUTE_TAB" && m.tabId === 1));
  });

  await test("routed row without extension mic grant offers setup", async () => {
    const env = setup({ tabs: [{ ...yt, audible: false }], activeId: 1, routes: { 1: { sinkId: "" } },
      devices: () => ({ granted: false, devices: [{ deviceId: "", label: "" }] }) });
    await tick();
    const sel = rowOf(env.list, 1).find((e) => e.tag === "select");
    assert.ok(sel, "routed tab listed even when not audible");
    assert.deepEqual(sel.children.map((o) => o.textContent), ["System Default", "Show device names…", "Stop routing"]);
    sel.selectedIndex = 1; sel.l.change();
    assert.deepEqual(env.created, [{ url: "setup.html" }]);
  });

  console.log(`${passed} passed`);
})();
