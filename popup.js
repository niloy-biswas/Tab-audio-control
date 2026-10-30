const listEl = document.getElementById("tabList");
const emptyEl = document.getElementById("empty");
const micRowEl = document.getElementById("micRow");

let currentIds = new Set();

function setFill(slider) {
  slider.style.setProperty("--pct", `${(slider.value / slider.max) * 100}%`);
}

function buildSlider(initialValue, onChange, max = 100) {
  const sliderWrap = document.createElement("span");
  sliderWrap.className = "track-slider";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = String(max);
  const initialPct = Math.round(initialValue * 100);
  slider.value = String(initialPct);
  setFill(slider);
  sliderWrap.appendChild(slider);

  const pct = document.createElement("span");
  pct.className = "track-pct";
  pct.textContent = `${initialPct}%`;

  slider.addEventListener("input", () => {
    const pctValue = Number(slider.value);
    pct.textContent = `${pctValue}%`;
    setFill(slider);
    onChange(pctValue / 100);
  });

  return { sliderWrap, pct };
}

const UNREACHABLE_HINT = "Refresh this tab to enable controls";

function buildHint(text) {
  const hint = document.createElement("span");
  hint.className = "grant-hint";
  hint.textContent = text;
  hint.title = text; // errors can be longer than the row
  return hint;
}

// Routing changes a row's slider range and Out controls, which the
// same-tab-set guard in loadTabs would otherwise never re-render.
function reloadRows() {
  currentIds = new Set();
  loadTabs();
}

function buildDeviceLine(tab, sinkId, routed) {
  const line = document.createElement("div");
  line.className = "track-line";

  const label = document.createElement("span");
  label.className = "track-title track-mic-label";
  label.textContent = "Out";
  line.appendChild(label);

  const controlWrap = document.createElement("span");
  controlWrap.className = "device-control";
  line.appendChild(controlWrap);

  const requestGrant = () =>
    chrome.runtime.sendMessage({ type: "POPUP_REQUEST_GRANT", tabId: tab.id });
  const openSetup = () => chrome.tabs.create({ url: "setup.html" });
  const stopRouting = () =>
    chrome.runtime
      .sendMessage({ type: "POPUP_UNROUTE_TAB", tabId: tab.id })
      .then(reloadRows);

  function renderPill(text, onClick, hintText) {
    controlWrap.innerHTML = "";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "grant-pill";
    pill.textContent = text;
    pill.addEventListener("click", onClick);
    controlWrap.append(pill);
    if (hintText) controlWrap.append(buildHint(hintText));
  }

  // chrome.tabCapture only works on the tab the popup was opened over, so
  // another tab's button brings that tab forward instead.
  async function routeTab() {
    const [active] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    if (active?.id !== tab.id) {
      renderRoute("Open the popup again to route");
      chrome.tabs.update(tab.id, { active: true });
      chrome.windows.update(tab.windowId, { focused: true });
      return;
    }
    const mic = await navigator.permissions.query({ name: "microphone" });
    if (mic.state !== "granted") return openSetup();
    const res = await chrome.runtime.sendMessage({
      type: "POPUP_ROUTE_TAB",
      tabId: tab.id,
    });
    if (!res?.ok) throw new Error(res?.error);
    reloadRows();
  }

  function renderGrant() {
    renderPill(
      "Grant on page…",
      requestGrant,
      "click the button that appears on the tab",
    );
  }

  function renderRoute(hintText) {
    renderPill(
      "Route this tab",
      () =>
        routeTab().catch((e) =>
          renderRoute(
            e?.message ? `Couldn't route: ${e.message}` : "Couldn't route",
          ),
        ),
      hintText,
    );
  }

  function renderHint(text) {
    controlWrap.innerHTML = "";
    controlWrap.append(buildHint(text));
  }

  // actions: [{label, run}] appended after the devices; picking one runs it
  // and leaves the current device selected.
  function renderSelect(devices, actions) {
    controlWrap.innerHTML = "";
    const select = document.createElement("select");
    select.className = "device-select";

    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "System Default";
    select.appendChild(defaultOpt);

    devices.forEach((d) => {
      const opt = document.createElement("option");
      opt.value = d.deviceId;
      opt.textContent = d.label || "Unknown device";
      select.appendChild(opt);
    });

    actions.forEach(({ label }, i) => {
      const opt = document.createElement("option");
      opt.value = `__action${i}__`;
      opt.textContent = label;
      select.appendChild(opt);
    });

    select.value = devices.some((d) => d.deviceId === sinkId) ? sinkId : "";

    select.addEventListener("change", () => {
      const action = actions[select.selectedIndex - 1 - devices.length];
      if (action) {
        select.value = sinkId; // an action doesn't itself pick a device
        action.run();
        return;
      }
      sinkId = select.value;
      chrome.runtime.sendMessage({
        type: "POPUP_SET_SINK_ID",
        tabId: tab.id,
        sinkId: select.value,
      });
    });

    controlWrap.appendChild(select);
  }

  chrome.runtime
    .sendMessage({ type: "POPUP_GET_DEVICES", tabId: tab.id })
    .then(({ granted, devices, supported, reachable = true }) => {
      // Routed: these are the extension's devices. Without its mic grant
      // they're unlabelled, so offer setup instead of listing them.
      if (routed) {
        const stop = { label: "Stop routing", run: stopRouting };
        const setup = { label: "Show device names…", run: openSetup };
        renderSelect(granted ? devices : [], granted ? [stop] : [setup, stop]);
        return;
      }
      // Chrome has no selectAudioOutput(); there, a site's mic permission is
      // what unlocks labelled outputs, so check granted before supported.
      const addDevice = { label: "Add device…", run: requestGrant };
      if (granted && devices.length > 0) {
        renderSelect(devices, supported ? [addDevice] : []);
      } else if (!reachable) renderHint(UNREACHABLE_HINT);
      else if (supported) renderGrant();
      else renderRoute();
    })
    .catch(() => renderHint(UNREACHABLE_HINT));

  return line;
}

function buildRow(tab, volume, sinkId, routed) {
  const row = document.createElement("div");
  row.className = "track";
  row.dataset.tabId = tab.id;

  const line = document.createElement("div");
  line.className = "track-line";

  const icon = document.createElement("img");
  icon.src = tab.favIconUrl || "";
  icon.onerror = () => {
    icon.style.visibility = "hidden";
  };

  const title = document.createElement("span");
  title.className = "track-title";
  title.textContent = tab.title || tab.url || "Untitled tab";
  title.title = tab.title || tab.url || "";

  // A routed tab's gain node can boost; an element's volume stops at 1.
  const { sliderWrap, pct } = buildSlider(
    volume,
    (v) => {
      chrome.runtime.sendMessage({
        type: "POPUP_SET_VOLUME",
        tabId: tab.id,
        volume: v,
      });
    },
    routed ? 200 : 100,
  );

  line.append(icon, title, sliderWrap, pct);
  row.append(line, buildDeviceLine(tab, sinkId, routed));
  return row;
}

async function loadTabs() {
  const [tabs, volumes, micState, sinks, routes] = await Promise.all([
    chrome.tabs.query({}),
    chrome.runtime.sendMessage({ type: "GET_ALL_VOLUMES" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_MIC_STATE" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_SINKS" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_ROUTES" }),
  ]);
  const micActive = new Set(micState.active);

  const rows = tabs
    .filter(
      (tab) =>
        tab.audible ||
        volumes[tab.id] !== undefined ||
        micActive.has(tab.id) ||
        sinks[tab.id] !== undefined ||
        routes[tab.id] !== undefined,
    )
    .map((tab) => ({
      tab,
      volume: volumes[tab.id] ?? 1,
      sinkId: routes[tab.id]?.sinkId ?? sinks[tab.id] ?? "",
      routed: routes[tab.id] !== undefined,
    }));

  const newIds = new Set(rows.map((r) => r.tab.id));
  const sameSet =
    newIds.size === currentIds.size &&
    [...newIds].every((id) => currentIds.has(id));

  // Skip re-render if the same tabs are showing, so an in-progress drag
  // on one slider isn't clobbered by an unrelated audible-state change.
  if (sameSet && listEl.childElementCount > 0) return;

  currentIds = newIds;
  listEl.innerHTML = "";
  emptyEl.style.display = rows.length ? "none" : "block";
  rows.forEach(({ tab, volume, sinkId, routed }) =>
    listEl.appendChild(buildRow(tab, volume, sinkId, routed)),
  );
}

function initMicSection() {
  chrome.runtime.sendMessage({ type: "POPUP_GET_MIC_GAIN" }).then(({ gain }) => {
    const { sliderWrap, pct } = buildSlider(gain, (v) => {
      chrome.runtime.sendMessage({ type: "POPUP_SET_MIC_GAIN", gain: v });
    });
    const label = document.createElement("span");
    label.className = "track-title track-mic-label";
    label.textContent = "Mic";
    micRowEl.append(label, sliderWrap, pct);
  });
}

chrome.tabs.onUpdated.addListener(loadTabs);
chrome.tabs.onRemoved.addListener(loadTabs);

loadTabs();
initMicSection();
