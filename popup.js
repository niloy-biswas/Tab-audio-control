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

function buildRow(tab, volume) {
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
  row.append(line);
  return row;
}

async function loadTabs() {
  const [tabs, volumes, micState] = await Promise.all([
    chrome.tabs.query({}),
    chrome.runtime.sendMessage({ type: "GET_ALL_VOLUMES" }),
    chrome.runtime.sendMessage({ type: "GET_ALL_MIC_STATE" }),
  ]);
  const micActive = new Set(micState.active);

  const rows = tabs
    .filter(
      (tab) =>
        tab.audible || volumes[tab.id] !== undefined || micActive.has(tab.id),
    )
    .map((tab) => ({ tab, volume: volumes[tab.id] ?? 1 }));

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
  rows.forEach(({ tab, volume }) => listEl.appendChild(buildRow(tab, volume)));
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
