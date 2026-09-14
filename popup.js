const listEl = document.getElementById("tabList");
const emptyEl = document.getElementById("empty");

let currentIds = new Set();

function setFill(slider, pctValue) {
  slider.style.setProperty("--pct", `${pctValue}%`);
}

function buildRow(tab, volume) {
  const row = document.createElement("div");
  row.className = "track";
  row.dataset.tabId = tab.id;

  const icon = document.createElement("img");
  icon.src = tab.favIconUrl || "";
  icon.onerror = () => {
    icon.style.visibility = "hidden";
  };

  const title = document.createElement("span");
  title.className = "track-title";
  title.textContent = tab.title || tab.url || "Untitled tab";
  title.title = tab.title || tab.url || "";

  const sliderWrap = document.createElement("span");
  sliderWrap.className = "track-slider";

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  const initialPct = Math.round(volume * 100);
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
    chrome.runtime.sendMessage({
      type: "POPUP_SET_VOLUME",
      tabId: tab.id,
      volume: pctValue / 100,
    });
  });

  row.append(icon, title, sliderWrap, pct);
  return row;
}

async function loadTabs() {
  const [tabs, volumes] = await Promise.all([
    chrome.tabs.query({}),
    chrome.runtime.sendMessage({ type: "GET_ALL_VOLUMES" }),
  ]);

  const rows = tabs
    .filter((tab) => tab.audible || volumes[tab.id] !== undefined)
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

chrome.tabs.onUpdated.addListener(loadTabs);
chrome.tabs.onRemoved.addListener(loadTabs);

loadTabs();
