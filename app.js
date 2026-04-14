// --- Data layer ---
let entries = [];
let chartMode = 'kwh'; // 'kwh' | 'rate' | 'both'

function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const header = lines[0].toLowerCase();
  // Support both old "date" and new "datetime" headers
  const hasTime = header.includes('datetime');
  return lines.slice(1).map(line => {
    const parts = [];
    let current = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { parts.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    parts.push(current.trim());
    let datetime = parts[0];
    // Normalize old date-only format to include noon time
    if (datetime && !datetime.includes('T')) {
      datetime = datetime + 'T12:00';
    }
    return { datetime, kwh: parseFloat(parts[1]), note: parts[2] || '' };
  }).filter(e => e.datetime && !isNaN(e.kwh));
}

function toCSV(data) {
  const sorted = [...data].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const lines = ['datetime,kwh,note'];
  for (const e of sorted) {
    const note = e.note.includes(',') ? `"${e.note}"` : e.note;
    lines.push(`${e.datetime},${e.kwh},${note}`);
  }
  return lines.join('\n') + '\n';
}

// Compute kWh/day rates between consecutive readings
function computeRates(sorted) {
  const rates = [null]; // first point has no rate
  for (let i = 1; i < sorted.length; i++) {
    const prev = new Date(sorted[i - 1].datetime);
    const curr = new Date(sorted[i].datetime);
    const hours = (curr - prev) / (1000 * 60 * 60);
    if (hours > 0) {
      rates.push(sorted[i].kwh / (hours / 24));
    } else {
      rates.push(null);
    }
  }
  return rates;
}

// Format elapsed time between two datetimes
function formatElapsed(dtPrev, dtCurr) {
  const ms = new Date(dtCurr) - new Date(dtPrev);
  const hours = ms / (1000 * 60 * 60);
  if (hours < 24) return `${hours.toFixed(1)}h`;
  const days = hours / 24;
  if (days < 1.1) return '1 day';
  return `${days.toFixed(1)} days`;
}

function formatDateTime(dt) {
  const d = new Date(dt);
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return `${date}, ${time}`;
}

// --- localStorage ---
function saveLocal() {
  localStorage.setItem('electricity-data', JSON.stringify(entries));
}

function loadLocal() {
  const raw = localStorage.getItem('electricity-data');
  if (raw) entries = JSON.parse(raw);
}

// --- GitHub API ---
function getGHConfig() {
  const token = localStorage.getItem('gh-token');
  const repo = CONFIG.githubRepo;
  const branch = CONFIG.githubBranch || 'main';
  const path = CONFIG.csvPath || 'data.csv';
  if (!token || !repo) return null;
  return { token, repo, branch, path };
}

async function ghFetch(config) {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.path}?ref=${config.branch}&_=${Date.now()}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${config.token}`, Accept: 'application/vnd.github.v3+json' },
    cache: 'no-store'
  });
  if (!res.ok) throw new Error(`GitHub fetch failed: ${res.status}`);
  const json = await res.json();
  const content = atob(json.content.replace(/\n/g, ''));
  return { content, sha: json.sha };
}

async function ghPush(config, csvContent, sha) {
  const url = `https://api.github.com/repos/${config.repo}/contents/${config.path}`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${config.token}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      message: `Update electricity data - ${new Date().toISOString().split('T')[0]}`,
      content: btoa(csvContent),
      sha,
      branch: config.branch
    })
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(`GitHub push failed: ${err.message}`);
  }
  return res.json();
}

let currentSHA = null;

async function syncFromGitHub() {
  const config = getGHConfig();
  if (!config) return false;
  try {
    const { content, sha } = await ghFetch(config);
    currentSHA = sha;
    entries = parseCSV(content);
    saveLocal();
    return true;
  } catch (e) {
    console.error('GitHub sync failed:', e);
    return false;
  }
}

async function syncToGitHub(retries = 2) {
  const config = getGHConfig();
  if (!config) return;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      // Fetch the current SHA right before pushing
      const { sha } = await ghFetch(config);
      const result = await ghPush(config, toCSV(entries), sha);
      // Use the SHA returned by the push for the next operation
      currentSHA = result.content.sha;
      updateSyncStatus(true);
      return;
    } catch (e) {
      if (attempt < retries && e.message.includes('does not match')) {
        // SHA conflict — wait briefly for GitHub to settle, then retry
        await new Promise(r => setTimeout(r, 1000));
        continue;
      }
      console.error('GitHub push failed:', e);
      updateSyncStatus(false, e.message);
    }
  }
}

function updateSyncStatus(connected, error) {
  const el = document.getElementById('sync-status');
  if (connected) {
    el.textContent = 'Synced with GitHub';
    el.className = 'sync-status connected';
  } else if (error) {
    el.textContent = `Sync error: ${error}`;
    el.className = 'sync-status';
  } else if (getGHConfig()) {
    el.textContent = 'GitHub configured';
    el.className = 'sync-status connected';
  } else {
    el.textContent = 'Local only';
    el.className = 'sync-status';
  }
}

// --- Stats ---
function renderStats() {
  const sorted = [...entries].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const rates = computeRates(sorted);

  // Latest reading
  const latest = sorted[sorted.length - 1];
  document.getElementById('stat-latest').textContent = latest ? `${latest.kwh} kWh` : '--';
  document.getElementById('stat-latest-date').textContent = latest ? formatDateTime(latest.datetime) : '--';

  // Average daily rate
  const validRates = rates.filter(r => r !== null);
  const avgRate = validRates.length > 0
    ? validRates.reduce((a, b) => a + b, 0) / validRates.length
    : null;
  document.getElementById('stat-avg-rate').textContent = avgRate !== null ? avgRate.toFixed(1) : '--';

  // Trend: compare last rate to average of prior rates
  const trendEl = document.getElementById('stat-trend');
  const trendLabelEl = document.getElementById('stat-trend-label');
  if (validRates.length >= 2) {
    const lastRate = validRates[validRates.length - 1];
    const priorAvg = validRates.slice(0, -1).reduce((a, b) => a + b, 0) / (validRates.length - 1);
    const pctChange = ((lastRate - priorAvg) / priorAvg) * 100;
    const sign = pctChange > 0 ? '+' : '';
    trendEl.textContent = `${sign}${pctChange.toFixed(1)}%`;
    trendEl.className = 'stat-value ' + (pctChange > 2 ? 'trend-up' : pctChange < -2 ? 'trend-down' : 'trend-flat');
    trendLabelEl.textContent = 'vs prior avg rate';
  } else {
    trendEl.textContent = '--';
    trendEl.className = 'stat-value trend-flat';
    trendLabelEl.textContent = 'need 3+ readings';
  }

  // Count and span
  document.getElementById('stat-count').textContent = entries.length;
  if (sorted.length >= 2) {
    const span = formatElapsed(sorted[0].datetime, sorted[sorted.length - 1].datetime);
    document.getElementById('stat-span').textContent = `over ${span}`;
  } else {
    document.getElementById('stat-span').textContent = '--';
  }
}

// --- Chart ---
let chart = null;

function renderChart() {
  const sorted = [...entries].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const rates = computeRates(sorted);
  const ctx = document.getElementById('chart').getContext('2d');

  const kwhData = sorted.map(e => ({ x: new Date(e.datetime), y: e.kwh }));
  const rateData = sorted.map((e, i) => ({
    x: new Date(e.datetime),
    y: rates[i] !== null ? parseFloat(rates[i].toFixed(2)) : null
  })).filter(d => d.y !== null);

  const noteIndicesKwh = sorted
    .map((e, i) => e.note ? i : null)
    .filter(i => i !== null);
  const noteIndicesRate = [];
  let rateIdx = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (rates[i] === null) continue;
    if (sorted[i].note) noteIndicesRate.push(rateIdx);
    rateIdx++;
  }

  const datasets = [];

  if (chartMode === 'kwh' || chartMode === 'both') {
    datasets.push({
      label: 'kWh',
      data: kwhData,
      borderColor: '#58a6ff',
      backgroundColor: 'rgba(88,166,255,0.1)',
      fill: chartMode === 'kwh',
      tension: 0.3,
      pointRadius: kwhData.map((_, i) => noteIndicesKwh.includes(i) ? 7 : 4),
      pointBackgroundColor: kwhData.map((_, i) =>
        noteIndicesKwh.includes(i) ? '#f0883e' : '#58a6ff'
      ),
      pointBorderColor: kwhData.map((_, i) =>
        noteIndicesKwh.includes(i) ? '#f0883e' : '#58a6ff'
      ),
      pointHoverRadius: 8,
      yAxisID: 'y'
    });
  }

  if (chartMode === 'rate' || chartMode === 'both') {
    datasets.push({
      label: 'kWh/day',
      data: rateData,
      borderColor: '#3fb950',
      backgroundColor: 'rgba(63,185,80,0.1)',
      fill: chartMode === 'rate',
      tension: 0.3,
      borderDash: chartMode === 'both' ? [6, 3] : [],
      pointRadius: rateData.map((_, i) => noteIndicesRate.includes(i) ? 7 : 4),
      pointBackgroundColor: rateData.map((_, i) =>
        noteIndicesRate.includes(i) ? '#f0883e' : '#3fb950'
      ),
      pointBorderColor: rateData.map((_, i) =>
        noteIndicesRate.includes(i) ? '#f0883e' : '#3fb950'
      ),
      pointHoverRadius: 8,
      yAxisID: chartMode === 'both' ? 'y1' : 'y'
    });
  }

  const scales = {
    x: {
      type: 'time',
      time: {
        tooltipFormat: 'MMM d, yyyy h:mm a',
        displayFormats: {
          hour: 'MMM d, ha',
          day: 'MMM d',
          week: 'MMM d'
        }
      },
      grid: { color: '#21262d' },
      ticks: { color: '#8b949e' }
    }
  };

  if (chartMode === 'kwh') {
    scales.y = {
      title: { display: true, text: 'kWh', color: '#8b949e' },
      grid: { color: '#21262d' },
      ticks: { color: '#8b949e' },
      beginAtZero: false
    };
  } else if (chartMode === 'rate') {
    scales.y = {
      title: { display: true, text: 'kWh / day', color: '#8b949e' },
      grid: { color: '#21262d' },
      ticks: { color: '#8b949e' },
      beginAtZero: false
    };
  } else {
    scales.y = {
      title: { display: true, text: 'kWh', color: '#58a6ff' },
      grid: { color: '#21262d' },
      ticks: { color: '#58a6ff' },
      position: 'left',
      beginAtZero: false
    };
    scales.y1 = {
      title: { display: true, text: 'kWh / day', color: '#3fb950' },
      grid: { drawOnChartArea: false },
      ticks: { color: '#3fb950' },
      position: 'right',
      beginAtZero: false
    };
  }

  if (chart) chart.destroy();

  chart = new Chart(ctx, {
    type: 'line',
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: { mode: 'index', intersect: false },
      scales,
      plugins: {
        legend: { display: chartMode === 'both', labels: { color: '#8b949e' } },
        tooltip: {
          callbacks: {
            afterBody(items) {
              const idx = items[0]?.dataIndex;
              if (idx != null && sorted[idx]?.note) {
                return `Note: ${sorted[idx].note}`;
              }
              return '';
            }
          }
        }
      }
    }
  });
}

// --- Table ---
function renderTable() {
  const sorted = [...entries].sort((a, b) => b.datetime.localeCompare(a.datetime));
  const chronological = [...entries].sort((a, b) => a.datetime.localeCompare(b.datetime));
  const rates = computeRates(chronological);

  // Build rate map: datetime -> rate
  const rateMap = new Map();
  chronological.forEach((e, i) => {
    rateMap.set(e.datetime, rates[i]);
  });

  // Build elapsed map: datetime -> elapsed from previous
  const elapsedMap = new Map();
  for (let i = 1; i < chronological.length; i++) {
    elapsedMap.set(chronological[i].datetime,
      formatElapsed(chronological[i - 1].datetime, chronological[i].datetime));
  }

  const tbody = document.querySelector('#data-table tbody');
  tbody.innerHTML = sorted.map(e => {
    const rate = rateMap.get(e.datetime);
    const elapsed = elapsedMap.get(e.datetime);
    return `
    <tr>
      <td>${formatDateTime(e.datetime)}</td>
      <td>${e.kwh}</td>
      <td>${rate !== null && rate !== undefined ? `<span class="rate-value">${rate.toFixed(1)}</span>` : '--'}</td>
      <td>${elapsed ? `<span class="elapsed">${elapsed}</span>` : '<span class="elapsed">first</span>'}</td>
      <td>${e.note}</td>
      <td><button class="delete-btn" data-dt="${e.datetime}" data-kwh="${e.kwh}" title="Delete">&times;</button></td>
    </tr>`;
  }).join('');
}

function render() {
  renderStats();
  renderChart();
  renderTable();
}

// --- Events ---
document.getElementById('settings-toggle').addEventListener('click', () => {
  const panel = document.getElementById('settings-panel');
  panel.classList.toggle('hidden');
  document.getElementById('gh-token').value = localStorage.getItem('gh-token') || '';
});

document.getElementById('save-token').addEventListener('click', async () => {
  localStorage.setItem('gh-token', document.getElementById('gh-token').value.trim());
  const ok = await syncFromGitHub();
  updateSyncStatus(ok);
  if (ok) render();
  document.getElementById('settings-panel').classList.add('hidden');
});

document.getElementById('clear-token').addEventListener('click', () => {
  localStorage.removeItem('gh-token');
  currentSHA = null;
  updateSyncStatus(false);
  document.getElementById('settings-panel').classList.add('hidden');
});

// Chart mode toggle
document.querySelectorAll('.chart-toggle').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.chart-toggle').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartMode = btn.dataset.mode;
    renderChart();
  });
});

document.getElementById('entry-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const date = document.getElementById('entry-date').value;
  const time = document.getElementById('entry-time').value;
  const datetime = `${date}T${time}`;
  const kwh = parseFloat(document.getElementById('entry-kwh').value);
  const note = document.getElementById('entry-note').value.trim();

  // Remove existing entry for same datetime (update)
  entries = entries.filter(e => e.datetime !== datetime);
  entries.push({ datetime, kwh, note });
  saveLocal();
  render();

  if (getGHConfig()) await syncToGitHub();

  document.getElementById('entry-form').reset();
  setDefaultDateTime();
});

document.querySelector('#data-table tbody').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('delete-btn')) return;
  const dt = e.target.dataset.dt;
  const kwh = parseFloat(e.target.dataset.kwh);
  entries = entries.filter(e => !(e.datetime === dt && e.kwh === kwh));
  saveLocal();
  render();
  if (getGHConfig()) await syncToGitHub();
});

document.getElementById('export-csv').addEventListener('click', () => {
  const blob = new Blob([toCSV(entries)], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'electricity-data.csv';
  a.click();
  URL.revokeObjectURL(url);
});

document.getElementById('import-csv').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    const imported = parseCSV(reader.result);
    if (imported.length === 0) { alert('No valid data found in CSV.'); return; }
    const map = new Map(entries.map(e => [e.datetime, e]));
    for (const e of imported) map.set(e.datetime, e);
    entries = Array.from(map.values());
    saveLocal();
    render();
    if (getGHConfig()) await syncToGitHub();
  };
  reader.readAsText(file);
  e.target.value = '';
});

function setDefaultDateTime() {
  const now = new Date();
  document.getElementById('entry-date').value = now.toISOString().split('T')[0];
  document.getElementById('entry-time').value =
    now.getHours().toString().padStart(2, '0') + ':' +
    now.getMinutes().toString().padStart(2, '0');
}

// --- Init ---
async function init() {
  setDefaultDateTime();

  const config = getGHConfig();
  if (config) {
    const ok = await syncFromGitHub();
    updateSyncStatus(ok);
    if (ok) { render(); return; }
  }

  loadLocal();
  if (entries.length > 0) {
    updateSyncStatus(false);
    render();
    return;
  }

  try {
    const res = await fetch('data.csv');
    if (res.ok) {
      entries = parseCSV(await res.text());
      saveLocal();
    }
  } catch (_) {}

  updateSyncStatus(false);
  render();
}

init();
