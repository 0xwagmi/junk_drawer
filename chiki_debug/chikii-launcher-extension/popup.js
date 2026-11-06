const STORAGE_KEY = 'chikiiCatalog';

// CHIKII_MISSING_GAMES comes from missing_games_seed.js (loaded before this
// script) — a one-time snapshot from an earlier web-vs-mobile crawl diff.
// Used only as a fallback/backfill for entries a live Refresh crawl (which now
// does its own web+mobile diff, see content_main.js crawlCatalog) might have
// missed. Live-crawled `missing` flags always take priority over this seed.
const SEED_ENTRIES = (typeof CHIKII_MISSING_GAMES !== 'undefined' ? CHIKII_MISSING_GAMES : []);

function mergeSeed(catalog) {
  const known = new Set(catalog.map((g) => `${g.communityId}:${g.name}`));
  const merged = catalog.map((g) => ({ ...g, missing: !!g.missing }));
  for (const seed of SEED_ENTRIES) {
    if (!known.has(`${seed.communityId}:${seed.name}`)) merged.push(seed);
  }
  merged.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  return merged;
}

const searchEl = document.getElementById('search');
const resultsEl = document.getElementById('results');
const statusEl = document.getElementById('status');
const countEl = document.getElementById('count');
const breakdownEl = document.getElementById('breakdown');
const missingOnlyEl = document.getElementById('missingOnly');
const refreshBtn = document.getElementById('refresh');
const manualIdEl = document.getElementById('manualId');
const manualOpenBtn = document.getElementById('manualOpen');

let catalog = [];

function updateBreakdown() {
  const missingCount = catalog.filter((g) => g.missing).length;
  breakdownEl.textContent = `${catalog.length - missingCount} on website, ${missingCount} missing`;
}

async function loadCatalog() {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const entry = data[STORAGE_KEY];
  if (entry) {
    catalog = mergeSeed(entry.catalog);
    statusEl.textContent = `${catalog.length} games cached (updated ${new Date(entry.updatedAt).toLocaleString()})`;
  } else {
    catalog = mergeSeed([]);
    statusEl.textContent = `No catalog crawled yet (${catalog.length} seeded entries available) — click Refresh for full coverage.`;
  }
  updateBreakdown();
}

async function getActiveChikiiTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !tab.url.includes('chikiigame.com')) return null;
  return tab;
}

function renderResults(items) {
  resultsEl.innerHTML = '';
  countEl.textContent = `${items.length} shown`;
  for (const item of items) {
    const row = document.createElement('div');
    row.className = 'row' + (item.missing ? ' missing' : '');
    row.onclick = () => openGame(item.communityId, item.name);
    const label = document.createElement('span');
    label.className = 'name';
    label.textContent = item.name;
    if (item.missing) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = 'MISSING';
      label.appendChild(badge);
    }
    const btn = document.createElement('button');
    btn.textContent = 'Open';
    btn.onclick = (ev) => { ev.stopPropagation(); openGame(item.communityId, item.name); };
    row.appendChild(label);
    row.appendChild(btn);
    resultsEl.appendChild(row);
  }
}

function getFilteredItems() {
  const q = searchEl.value.trim().toLowerCase();
  let items = catalog;
  if (missingOnlyEl.checked) items = items.filter((g) => g.missing);
  if (q) items = items.filter((g) => g.name && g.name.toLowerCase().includes(q));
  return items;
}

function refreshView() {
  renderResults(getFilteredItems());
}

async function openGame(communityId, name) {
  const tab = await getActiveChikiiTab();
  if (!tab) {
    statusEl.textContent = 'Open a chikiigame.com tab first (any GameLibrary page).';
    return;
  }
  statusEl.textContent = `Opening ${name || communityId}...`;
  const result = await chrome.tabs.sendMessage(tab.id, { action: 'open', communityId: Number(communityId) });
  if (result && result.ok) {
    statusEl.textContent = `Opened ${name || communityId}. Check the tab.`;
  } else {
    statusEl.textContent = `Failed: ${(result && result.error) || 'unknown error'}`;
  }
}

searchEl.addEventListener('input', refreshView);

searchEl.addEventListener('keydown', (ev) => {
  if (ev.key !== 'Enter') return;
  const top = getFilteredItems()[0];
  if (top) openGame(top.communityId, top.name);
});

missingOnlyEl.addEventListener('change', refreshView);

refreshBtn.addEventListener('click', async () => {
  const tab = await getActiveChikiiTab();
  if (!tab) {
    statusEl.textContent = 'Open a chikiigame.com tab (logged in, on #/GameLibrary) first.';
    return;
  }
  refreshBtn.disabled = true;
  statusEl.textContent = 'Crawling live catalog as web + mobile (two full passes, can take ~1-2 min)...';
  const port = chrome.tabs.connect(tab.id, { name: 'chikii-crawl' });
  port.onMessage.addListener(async (msg) => {
    if (msg.type === 'progress') {
      statusEl.textContent = `Crawling: ${msg.progress.phase} — ${msg.progress.done} games found so far`;
    } else if (msg.type === 'done') {
      refreshBtn.disabled = false;
      if (msg.result && msg.result.ok) {
        await chrome.storage.local.set({ [STORAGE_KEY]: { catalog: msg.result.catalog, updatedAt: Date.now() } });
        catalog = mergeSeed(msg.result.catalog);
        updateBreakdown();
        statusEl.textContent = `Done: ${catalog.length} games cached.`;
        refreshView();
      } else {
        statusEl.textContent = `Crawl failed: ${(msg.result && msg.result.error) || 'unknown error'}`;
      }
    }
  });
  port.postMessage({ action: 'crawl' });
});

manualOpenBtn.addEventListener('click', () => {
  const id = manualIdEl.value.trim();
  if (!id) return;
  openGame(id, null);
});

loadCatalog().then(refreshView);
