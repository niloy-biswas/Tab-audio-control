const listEl = document.getElementById("tabList");
const emptyEl = document.getElementById("empty");
const micRowEl = document.getElementById("micRow");

let currentIds = new Set();

function setFill(slider, pctValue) {
  slider.style.setProperty("--pct", `${pctValue}%`);
}

function buildSlider(initialValue, onChange) {
  const sliderWrap = document.createElement("span");
  sliderWrap.className = "track-slider";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  const initialPct = Math.round(initialValue * 100);
  slider.value = String(initialPct);
  setFill(slider, initialPct);
  sliderWrap.appendChild(slider);

  const pct = document.createElement("span");
  pct.className = "track-pct";
  pct.textContent = `${initialPct}%`;

  slider.addEventListener("input", () => {
    const pctValue = Number(slider.value);
    pct.textContent = `${pctValue}%`;
    setFill(slider, pctValue);
    onChange(pctValue / 100);
  });

  return { sliderWrap, pct };
}

function buildHint(text) {
  const hint = document.createElement("span");
  hint.className = "grant-hint";
  hint.textContent = text;
  return hint;
}

function buildDeviceLine(tab, sinkId) {
  const line = document.createElement("div");
  line.className = "track-line";

  const label = document.createElement("span");
  label.className = "track-title track-mic-label";
  label.textContent = "Out";
  line.appendChild(label);

  const controlWrap = document.createElement("span");
  controlWrap.className = "device-control";
  line.appendChild(controlWrap);

  function renderGrant() {
    controlWrap.innerHTML = "";
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "grant-pill";
    pill.textContent = "Grant on page…";
    pill.addEventListener("click", () => {
      chrome.runtime.sendMessage({
        type: "POPUP_REQUEST_GRANT",
        tabId: tab.id,
      });
    });
    controlWrap.append(
      pill,
      buildHint("click the button that appears on the tab"),
    );
  }

  function renderUnsupported() {
    controlWrap.innerHTML = "";
    controlWrap.append(
      buildHint("Output device choice isn't allowed on this site"),
    );
  }

  function renderSelect(devices) {
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

    const addOpt = document.createElement("option");
    addOpt.value = "__add__";
    addOpt.textContent = "Add device…";
    select.appendChild(addOpt);

    select.value = devices.some((d) => d.deviceId === sinkId) ? sinkId : "";

    select.addEventListener("change", () => {
      if (select.value === "__add__") {
        select.value = sinkId; // granting doesn't itself pick a device
        chrome.runtime.sendMessage({
          type: "POPUP_REQUEST_GRANT",
          tabId: tab.id,
        });
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
    .then(({ granted, devices, supported }) => {
      if (!supported) renderUnsupported();
      else if (granted && devices.length > 0) renderSelect(devices);
      else renderGrant();
    })
    .catch(renderGrant);

  return line;
}

function buildRow(tab, volume, sinkId) {
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

  const { sliderWrap, pct } = buildSlider(volume, (v) => {
    chrome.runtime.sendMessage({
      type: "POPUP_SET_VOLUME",
      tabId: tab.id,
      volume: v,
    });
  });

  line.append(icon, title, sliderWrap, pct);
  row.append(line, buildDeviceLine(tab, sinkId));
  return row;
}

async function loadTabs() {
  const [tabs, volumes, micState, sinks] = await Promise.all([
    chrome.tabs.query({}),
    chrome.runtime.sendMessage({ type: "GET_ALL_VOLUMES" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_MIC_STATE" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_SINKS" }),
  ]);
  const micActive = new Set(micState.active);

  const rows = tabs
    .filter(
      (tab) =>
        tab.audible ||
        volumes[tab.id] !== undefined ||
        micActive.has(tab.id) ||
        sinks[tab.id] !== undefined,
    )
    .map((tab) => ({
      tab,
      volume: volumes[tab.id] ?? 1,
      sinkId: sinks[tab.id] ?? "",
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
  rows.forEach(({ tab, volume, sinkId }) =>
    listEl.appendChild(buildRow(tab, volume, sinkId)),
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
