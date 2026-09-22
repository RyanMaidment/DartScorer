/* ==========================================================================
   Thursday Night Dart League — TV Scoreboard
   -------------------------------------------------------------------------
   How this works now:
   NOTE: this board lives in /board/ and reuses the site's existing ../styles.css.
   Your original board at the site root is untouched, so you can compare the two
   and switch over when you're happy.

   - The board listens LIVE to the league database (Firebase Firestore).
     When a scorer enters a turn on a tablet, the number changes on the TV
     within a moment — no polling, no Google Sheet, no scripts.
   - lib/board-model.js turns tonight's matches into board data
     ({ meta, matches, awards, menTop8, womenTop8, news }); the render functions
     below draw it using the class names in the site's styles.css.
   - If the database can't be reached on the very first load, it falls back
     to the snapshot in data.json so the screen is never blank. Once Firestore
     has loaded once, its offline cache keeps the board alive if the Wi-Fi drops.
   - Reading is public (no login) so the TV just needs the page open.
   ========================================================================== */

import { createStore } from '../lib/store.js';
import { buildBoardModel } from '../lib/board-model.js';

let lastData = null;
let usedFallback = false;

const state = { config: null, players: null, matches: null, nightId: null, meta: {} };
let store = null;
let unsubMatches = null;

start();

async function start() {
  updateClock();
  setInterval(updateClock, 1000);
  setupFullscreenToggle();

  try {
    store = await createStore();
  } catch (err) {
    console.error('Could not start the league database:', err);
    setStatus('error');
    await loadFallback();
    return;
  }

  store.onConfig((cfg, meta) => {
    state.config = cfg || {};
    state.meta.config = meta;
    const nightId = (cfg && cfg.currentNight) || null;
    if (nightId !== state.nightId) watchNight(nightId);
    refresh();
  });
  store.onPlayers((players, meta) => {
    state.players = players;
    state.meta.players = meta;
    refresh();
  });

  // If nothing has arrived after a few seconds, show the saved snapshot instead of a blank TV.
  setTimeout(() => { if (!lastData) loadFallback(); }, 8000);
}

function watchNight(nightId) {
  if (unsubMatches) { unsubMatches(); unsubMatches = null; }
  state.nightId = nightId;
  state.matches = nightId ? null : [];
  if (nightId) {
    unsubMatches = store.onMatches(nightId, (matches, meta) => {
      state.matches = matches;
      state.meta.matches = meta;
      refresh();
    });
  }
}

function refresh() {
  if (!state.config || !state.players || !state.matches) return;
  const data = buildBoardModel({ config: state.config, players: state.players, matches: state.matches });
  render(data);
  lastData = data;

  const metas = Object.values(state.meta).filter(Boolean);
  if (metas.some((m) => m.error)) setStatus('error');
  else if (store.kind === 'demo') setStatus('demo');
  else if (metas.some((m) => m.fromCache)) setStatus('cache');
  else setStatus('live');
}

async function loadFallback() {
  if (usedFallback || lastData) return;
  usedFallback = true;
  try {
    const res = await fetch('../data.json', { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    render(data);
    lastData = data;
    setStatus('error');
  } catch (err) {
    console.error('No fallback data.json available either:', err);
  }
}

/* --------------------------------------------------------------- render -- */

function render(data) {
  const name = document.getElementById('league-name');
  if (data.meta && data.meta.leagueName) {
    name.textContent = data.meta.leagueName;
    document.title = `${data.meta.leagueName} — Live Board`;
  }

  renderMatches(data.matches || []);
  renderAwards(data.awards || []);
  renderLeaderboard('men-list', data.menTop8 || []);
  renderLeaderboard('women-list', data.womenTop8 || []);
  renderTicker(data.news || []);
}

/* ------------------------------------------------------------ matchups -- */

function renderMatches(matches) {
  const list = document.getElementById('match-list');
  list.innerHTML = '';

  if (!matches.length) {
    list.innerHTML = '<li class="empty-note">No matchups set for tonight yet.</li>';
    return;
  }

  matches.forEach((m, i) => {
    const prev = lastData && lastData.matches && lastData.matches[i];
    const changed = prev && (prev.scoreA !== m.scoreA || prev.scoreB !== m.scoreB);

    const li = document.createElement('li');
    li.className = 'match-row';
    if (m.scoreA > m.scoreB) li.classList.add('a-leads');
    else if (m.scoreB > m.scoreA) li.classList.add('b-leads');

    li.innerHTML = `
      <div class="side side-a">
        <span class="team-token">${escapeHtml(m.teamANum)}</span>
        <div class="team-info">
          <p class="team-players">${escapeHtml(m.teamAPlayers.join(', '))}</p>
        </div>
      </div>
      <div class="score-box${changed ? ' flash' : ''}">
        <span class="score-a">${formatScore(m.scoreA)}</span>
        <span class="divider">:</span>
        <span class="score-b">${formatScore(m.scoreB)}</span>
      </div>
      <div class="side side-b">
        <span class="team-token">${escapeHtml(m.teamBNum)}</span>
        <div class="team-info">
          <p class="team-players">${escapeHtml(m.teamBPlayers.join(', '))}</p>
        </div>
      </div>
    `;
    list.appendChild(li);
  });
}

/* -------------------------------------------------------------- awards -- */

function renderAwards(awards) {
  const row = document.getElementById('award-row');
  row.innerHTML = '';

  awards.forEach(a => {
    const icon = a.gender === 'women' ? '\u2640' : '\u2642';
    const unit = a.unit || '% rating';
    const div = document.createElement('div');
    div.className = 'medallion';
    div.innerHTML = `
      <span class="coin">${icon}</span>
      <span class="title">${escapeHtml(a.title)}</span>
      <span class="name">${escapeHtml(a.name)}</span>
      <span class="rating">${formatNumber(a.rating)} ${escapeHtml(unit)}</span>
    `;
    row.appendChild(div);
  });
}

/* --------------------------------------------------------- leaderboards -- */

function renderLeaderboard(listId, players) {
  const list = document.getElementById(listId);
  const prevKey = listId === 'men-list' ? 'menTop8' : 'womenTop8';
  list.innerHTML = '';

  players.forEach((p, i) => {
    const prev = lastData && lastData[prevKey] && lastData[prevKey][i];
    const changed = prev && (prev.avg !== p.avg || prev.hs !== p.hs);

    const li = document.createElement('li');
    li.className = 'lb-row';
    const badges = (p.badges || []).join('');
    li.innerHTML = `
      <span class="lb-rank">${p.rank}</span>
      <span class="lb-name${changed ? ' flash' : ''}">
        <span class="player-name">${escapeHtml(p.name)}</span>
        ${badges ? `<span class="badges">${badges}</span>` : ''}
      </span>
      <span class="lb-avg">${formatNumber(p.avg)}</span>
      <span class="lb-hs">${p.hs || 0}</span>
    `;
    list.appendChild(li);
  });
}

/* --------------------------------------------------------------- ticker -- */

let lastTickerKey = '';

function renderTicker(news) {
  const track = document.getElementById('ticker-track');
  if (!news.length) {
    track.innerHTML = '';
    lastTickerKey = '';
    return;
  }
  // Only rebuild when the text changes, so the scroll doesn't restart on every score update.
  const key = news.join('\u0001');
  if (key === lastTickerKey) return;
  lastTickerKey = key;

  // Duplicate the list so the CSS marquee (translateX -50%) loops seamlessly.
  const itemsHtml = news.map(n => `<span class="ticker-item">${escapeHtml(n)}</span>`).join('');
  track.innerHTML = itemsHtml + itemsHtml;

  // Scale scroll speed to content length so short and long nights both read comfortably.
  const pxPerSecond = 60;
  const approxWidth = news.join('').length * 11 + news.length * 60;
  const duration = Math.max(18, (approxWidth * 2) / pxPerSecond);
  track.style.animationDuration = `${duration}s`;
}

/* ----------------------------------------------------------------- misc -- */

function updateClock() {
  const el = document.getElementById('clock');
  el.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatNumber(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '\u2014';
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

// Team points can be halves (1.5); show whole numbers without a decimal.
function formatScore(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function setupFullscreenToggle() {
  const btn = document.getElementById('fullscreen-toggle');
  const toggle = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.();
    }
  };
  btn.addEventListener('click', toggle);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'f' || e.key === 'F') toggle();
  });
}
