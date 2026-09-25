/* ==========================================================================
   Dart League — Admin
   Set up each week's matchups, manage the roster, save the night's stats
   (replaces "SAVE TO COMPLETE STATS SPREADSHEET"), export CSV, and edit the
   TV ticker messages and league settings.
   ========================================================================== */

import { createStore } from '../lib/store.js';
import { withRules, DEFAULT_RULES, shortName, slug, fmtPoints, matchResults, pointsPerMatch } from '../lib/engine.js';
import { teamNumbers, teamLabel, customTeamName, todayISO } from '../lib/night.js';
import { weeklyRows, toCsv } from '../lib/export.js';
import { SEED_PLAYERS } from '../lib/seed-data.js';
import { requestReport, reportDownloads, revokeDownloads } from '../lib/report.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const S = {
  store: null, kind: null,
  auth: { ready: false, signedIn: false, role: null },
  tab: 'tonight',
  config: null, players: null, nights: null, weekly: null,
  form: null,                 // "Tonight" form state
  draft: null,                // Settings form state
  statsNight: null, statsMatches: null,
  viewWeekId: null,           // which saved week is shown in "View a saved week"
  dirty: new Set(),           // roster rows with unsaved edits
  showSpares: false,
  msg: {},
  pendingRender: false,
  report: { state: 'idle' },   // "Build report" button: idle | building | done | error
};
let started = false, unsubStats = null;

boot();

async function boot() {
  try { S.store = await createStore(); }
  catch (err) { $('#app').innerHTML = `<div class="center"><h2>Couldn't start</h2>${esc(err.message || err)}</div>`; return; }
  S.kind = S.store.kind;
  S.auth = { ready: true, signedIn: true, role: 'admin' };   // no login: the page is open
  start();
  render(true);
}

function start() {
  if (started) return;
  started = true;
  S.store.onConfig((c) => { S.config = c || {}; render(); });
  S.store.onPlayers((p) => { S.players = p; render(); });
  S.store.onNights((n) => { S.nights = n.sort((a, b) => a.id.localeCompare(b.id)); render(); });
  S.store.onWeekly((w) => { S.weekly = w.sort((a, b) => a.id.localeCompare(b.id)); render(); });
}

/* ================================================================= render == */

const isTyping = () => {
  const a = document.activeElement;
  return a && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.closest('#panel');
};

function render(force = false) {
  const app = $('#app');
  if (!S.auth.ready) { app.innerHTML = '<div class="center">Loading…</div>'; return; }
  if (!S.config || !S.players || !S.nights || !S.weekly) { app.innerHTML = '<div class="center">Loading…</div>'; return; }

  // Don't wipe what the admin is typing or has changed but not yet saved.
  if (!force && (isTyping() || S.dirty.size)) { S.pendingRender = true; return; }
  S.pendingRender = false;

  initForms();
  app.innerHTML = `
    <div class="wrap">
      <header class="top">
        <h1>${esc(S.config.name || 'Dart League')}<small>ADMIN</small></h1>
        ${S.kind === 'demo' ? '<span class="flag">DEMO</span>' : ''}
        <a class="btn small" href="../score/${S.kind === 'demo' ? '?demo' : ''}">Scorer</a>
        <a class="btn small" href="../board/${S.kind === 'demo' ? '?demo' : ''}" target="_blank">TV board</a>
      </header>
      <nav class="tabs">
        ${[['tonight', 'Nights & matchups'], ['roster', 'Roster'], ['teams', 'Team names'], ['stats', 'Stats & export'], ['settings', 'Settings']]
          .map(([id, label]) => `<button class="${S.tab === id ? 'on' : ''}" data-act="tab" data-tab="${id}">${label}</button>`).join('')}
      </nav>
      <div id="panel">${S.tab === 'tonight' ? tonightTab() : S.tab === 'roster' ? rosterTab() : S.tab === 'teams' ? teamsTab() : S.tab === 'stats' ? statsTab() : settingsTab()}</div>
    </div>`;
}

document.addEventListener('focusout', () => {
  setTimeout(() => { if (S.pendingRender && !isTyping() && !S.dirty.size) render(); }, 120);
});

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

/* Team label for lists: "The Honey Badgers (Alain P, Mike H, Sherley D)" or just the players */
function teamText(n) {
  const custom = customTeamName(S.config, n);
  const names = teamLabel(S.players, n);
  return custom ? `${custom} (${names})` : names;
}

/* ============================================================ tab: nights == */

function initForms() {
  if (!S.form) {
    const last = S.nights.length ? S.nights[S.nights.length - 1] : null;
    const teams = teamNumbers(S.players);
    const rows = Math.max(1, Math.floor(teams.length / 2));
    S.form = {
      date: todayISO(),
      week: last && last.week ? last.week + 1 : 1,
      pairs: Array.from({ length: rows }, () => ['', '']),
      makeCurrent: true,
    };
  }
  if (!S.draft) {
    const R = withRules(S.config.rules);
    S.draft = {
      name: S.config.name || '',
      news: (S.config.news || []).join('\n'),
      legsPerMatch: R.legsPerMatch, finishPoints: R.finishPoints, under100Points: R.under100Points,
      tonM: R.tonThreshold.M, tonF: R.tonThreshold.F, finishBadge: R.finishBadge,
      avgExcludesUnder100: !!R.avgExcludesUnder100,
    };
  }
}

function tonightTab() {
  const teams = teamNumbers(S.players);
  const opts = (sel) => '<option value="">— team —</option>' + teams.map((n) =>
    `<option value="${n}"${String(sel) === String(n) ? ' selected' : ''}>${n} · ${esc(teamText(n))}</option>`).join('');
  const f = S.form;
  const pairs = f.pairs.map((p, i) => `
    <div class="pair">
      <span class="n">${i + 1}</span>
      <select data-pair="${i}" data-side="0">${opts(p[0])}</select>
      <span class="vs">v</span>
      <select data-pair="${i}" data-side="1">${opts(p[1])}</select>
    </div>`).join('');

  const nightsList = S.nights.slice().reverse().map((n) => `
    <tr>
      <td>${esc(n.date)}</td><td>${n.week ? 'Week ' + esc(n.week) : ''}</td>
      <td>${(n.matches || []).length} matches</td>
      <td>${S.config.currentNight === n.id ? '<span class="pill cur">On the board</span>' : ''}</td>
      <td style="text-align:right">
        <button class="btn small" data-act="load-night" data-id="${esc(n.id)}">Edit</button>
        ${S.config.currentNight === n.id ? '' : `<button class="btn small" data-act="make-current" data-id="${esc(n.id)}">Show on board</button>`}
      </td></tr>`).join('');

  return `
    <div class="card">
      <h2>Set up a league night</h2>
      <p class="hint">Pick the date, week number and who plays whom. This creates the matches for the scorer tablets and puts tonight's matchups on the TV board.
        Matches that already have scores are never overwritten.</p>
      <div class="row">
        <div><label class="f">Date</label><input type="date" id="f-date" value="${esc(f.date)}"></div>
        <div><label class="f">Week #</label><input type="number" id="f-week" min="1" style="width:90px" value="${esc(f.week)}"></div>
      </div>
      ${pairs}
      <div class="row" style="margin-top:12px;align-items:center">
        <label><input type="checkbox" id="f-current" ${f.makeCurrent ? 'checked' : ''}> Show this night on the TV board and scorer tablets</label>
      </div>
      <button class="btn primary" data-act="create-night">Create / update night</button>
      <div class="msg ${S.msg.night && S.msg.night.err ? 'err' : 'ok'}">${esc(S.msg.night ? S.msg.night.text : '')}</div>
    </div>
    <div class="card">
      <h2>Nights</h2>
      ${S.nights.length ? `<table><tbody>${nightsList}</tbody></table>` : '<p class="hint">No nights yet — create the first one above.</p>'}
    </div>`;
}

function readPairs() {
  const bad = [];
  const seen = new Set();
  const pairings = [];
  S.form.pairs.forEach((p, i) => {
    const [a, b] = p;
    if (a === '' && b === '') return;
    if (a === '' || b === '') { bad.push(`Match ${i + 1} needs two teams.`); return; }
    if (a === b) bad.push(`Match ${i + 1}: a team can't play itself.`);
    for (const t of [a, b]) { if (seen.has(t)) bad.push(`Team ${t} is in more than one match.`); seen.add(t); }
    pairings.push([Number(a), Number(b)]);
  });
  if (!pairings.length) bad.push('Add at least one match.');
  return { bad: [...new Set(bad)], pairings };
}

async function createNight() {
  const { bad, pairings } = readPairs();
  const f = S.form;
  if (!f.date) bad.push('Pick a date.');
  if (bad.length) { S.msg.night = { err: true, text: bad.join(' ') }; render(true); return; }
  try {
    await S.store.createNight({ date: f.date, week: f.week, pairings, makeCurrent: f.makeCurrent });
    S.msg.night = { text: `Saved ${pairings.length} matches for ${f.date}${f.makeCurrent ? ' — now showing on the board and tablets.' : '.'}` };
  } catch (err) {
    S.msg.night = { err: true, text: err.message || String(err) };
  }
  render(true);
}

/* ============================================================ tab: roster == */

function rosterTab() {
  const list = [...S.players]
    .filter((p) => S.showSpares || !p.spare)
    .sort((a, b) => {
      const ta = a.spare ? 999 : (a.team ?? 998), tb = b.spare ? 999 : (b.team ?? 998);
      return ta - tb || (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name);
    });
  const noGender = S.players.filter((p) => p.gender === 'N' && !p.dummy && p.active !== false).length;
  const teams = teamNumbers(S.players).length;
  const spares = S.players.filter((p) => p.spare && !p.dummy).length;

  const rows = list.map((p) => `
    <tr data-pid="${esc(p.id)}" class="${p.gender === 'N' && !p.dummy ? 'nogender' : ''}">
      <td><input type="number" min="1" data-f="team" value="${p.team ?? ''}" ${p.spare ? 'disabled' : ''}></td>
      <td><input type="text" data-f="name" value="${esc(p.name)}"></td>
      <td><input type="text" data-f="short" value="${esc(p.short || '')}" style="width:130px"></td>
      <td><select data-f="gender">
        ${[['M', 'Male'], ['F', 'Female'], ['N', '— not set —']].map(([v, l]) => `<option value="${v}"${p.gender === v ? ' selected' : ''}>${l}</option>`).join('')}
      </select></td>
      <td><input type="checkbox" data-f="spare" ${p.spare ? 'checked' : ''} ${p.dummy ? 'disabled' : ''}></td>
      <td><input type="checkbox" data-f="active" ${p.active !== false ? 'checked' : ''}></td>
      <td style="white-space:nowrap">
        <button class="btn small good" data-act="save-player" data-id="${esc(p.id)}">Save</button>
        ${p.dummy ? '' : `<button class="btn small danger" data-act="delete-player" data-id="${esc(p.id)}">Delete</button>`}
      </td>
    </tr>`).join('');

  return `
    <div class="card">
      <h2>Roster</h2>
      <p class="hint">${S.players.filter((p) => !p.spare).length} team players on ${teams} teams · ${spares} spares.
        Gender decides the 100+ / 95+ threshold and which leaderboard a player appears on.
        ${noGender ? `<b style="color:var(--lose)">${noGender} active player(s) have no gender set (red edge) — they are left off the leaderboards until you set it.</b>` : ''}</p>
      <div class="row" style="align-items:center">
        <label><input type="checkbox" id="show-spares" ${S.showSpares ? 'checked' : ''}> Show spares</label>
        <button class="btn small" data-act="load-seed">Load starter roster from your spreadsheet</button>
      </div>
      <div class="table-scroll"><table>
        <thead><tr><th>Team</th><th>Name (as in stats)</th><th>Short name</th><th>Gender</th><th>Spare</th><th>Active</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
    </div>
    <div class="card">
      <h2>Add a player</h2>
      <div class="row">
        <div><label class="f">Name</label><input type="text" id="np-name" placeholder="First LAST" style="width:220px"></div>
        <div><label class="f">Gender</label><select id="np-gender"><option value="M">Male</option><option value="F">Female</option><option value="N">Not set</option></select></div>
        <div><label class="f">Team #</label><input type="number" id="np-team" min="1" style="width:80px"></div>
        <label style="padding-bottom:9px"><input type="checkbox" id="np-spare"> Spare (no team)</label>
        <button class="btn primary" data-act="add-player">Add</button>
      </div>
    </div>`;
}

async function savePlayerRow(id) {
  const tr = document.querySelector(`tr[data-pid="${CSS.escape(id)}"]`);
  const old = S.players.find((p) => p.id === id);
  if (!tr || !old) return;
  const get = (f) => tr.querySelector(`[data-f="${f}"]`);
  const spare = get('spare').checked;
  const team = get('team').value === '' || spare ? null : Number(get('team').value);
  const name = get('name').value.trim();
  if (!name) { toast('A player needs a name', 'error'); return; }
  const p = {
    ...old, name, short: get('short').value.trim() || shortName(name),
    gender: get('gender').value, spare, team, active: get('active').checked,
  };
  if (!spare && team === null && !old.dummy) { toast('Give this player a team number, or mark them as a spare', 'error'); return; }
  await S.store.savePlayer(p);
  S.dirty.delete(id);
  toast(`Saved ${name}`, 'good');
  render(true);
}

async function addPlayer() {
  const name = $('#np-name').value.trim();
  const gender = $('#np-gender').value;
  const spare = $('#np-spare').checked;
  const team = $('#np-team').value === '' ? null : Number($('#np-team').value);
  if (!name) { toast('Enter a name', 'error'); return; }
  if (!spare && team === null) { toast('Enter a team number, or tick Spare', 'error'); return; }
  let id = slug(name) || 'player';
  const ids = new Set(S.players.map((p) => p.id));
  for (let i = 2; ids.has(id); i++) id = `${slug(name)}_${i}`;
  const maxOrder = Math.max(0, ...S.players.filter((p) => p.order < 900).map((p) => p.order ?? 0));
  await S.store.savePlayer({
    id, name, short: shortName(name), gender, team: spare ? null : team,
    order: spare ? 900 : maxOrder + 1, spare, dummy: false, active: true,
  });
  toast(`Added ${name}`, 'good');
  render(true);
}

async function loadSeed() {
  const ok = window.confirm('Load the starter roster from your spreadsheet (48 team players, 32 spares, Dummy)?\n\nPlayers with the same name are overwritten with the spreadsheet version. Others are left alone.');
  if (!ok) return;
  await S.store.importPlayers(SEED_PLAYERS);
  toast('Starter roster loaded', 'good');
}

/* ========================================================== tab: team names == */

function teamsTab() {
  const rows = teamNumbers(S.players).map((n) => `
    <tr>
      <td class="num">${n}</td>
      <td>${esc(teamLabel(S.players, n))}</td>
      <td><input type="text" data-team="${n}" maxlength="30" value="${esc(customTeamName(S.config, n))}" placeholder="(no team name — show players)"></td>
    </tr>`).join('');
  return `
    <div class="card">
      <h2>Team names</h2>
      <p class="hint">Every team keeps its number. A team name is optional: when one is set it shows instead of the players' names
        on the TV board, the scorer and the exports. Leave a box empty to go back to showing the players' names.
        Teams can also set their own name on the scorer's match-setup screen, or from <b>More… → Team names</b>.</p>
      <div class="table-scroll" style="max-height:none"><table>
        <thead><tr><th class="num">Team</th><th>Players</th><th style="width:45%">Team name</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div style="margin-top:12px"><button class="btn primary" data-act="save-team-names">Save team names</button></div>
    </div>`;
}

async function saveTeamNames() {
  const map = {};
  document.querySelectorAll('input[data-team]').forEach((el) => {
    const n = el.dataset.team;
    const v = el.value.trim();
    if (v !== customTeamName(S.config, n)) map[n] = v;
  });
  if (!Object.keys(map).length) { toast('No changes to save'); return; }
  await S.store.saveTeamNames(map);
  toast('Team names saved', 'good');
  render(true);
}

/* ============================================================= tab: stats == */

function watchStatsNight(id) {
  if (unsubStats) { unsubStats(); unsubStats = null; }
  S.statsNight = id; S.statsMatches = null;
  // force: true — nothing on this tab is a text field mid-edit, so it's always safe to redraw
  // the instant new match data arrives. Without this, the preview table can get stuck showing
  // an old snapshot (e.g. from before a correction) even though the underlying data has since
  // updated — a CSV download, which reads fresh at click time, would show the current numbers
  // while the on-screen table sits frozen on the stale ones.
  if (id) unsubStats = S.store.onMatches(id, (m) => { S.statsMatches = m; if (S.tab === 'stats') render(true); });
}

function statsTab() {
  const ids = S.nights.map((n) => n.id);
  if (!S.statsNight || !ids.includes(S.statsNight)) {
    const pick = ids.includes(S.config.currentNight) ? S.config.currentNight : (ids[ids.length - 1] || null);
    if (pick && pick !== S.statsNight) { setTimeout(() => watchStatsNight(pick), 0); }
  }
  const night = S.nights.find((n) => n.id === S.statsNight);
  const R = withRules(S.config.rules);

  const nightSel = S.nights.slice().reverse().map((n) =>
    `<option value="${esc(n.id)}"${n.id === S.statsNight ? ' selected' : ''}>${esc(n.date)}${n.week ? ' · Week ' + esc(n.week) : ''}</option>`).join('');

  // Every saved week, sorted by real calendar date (not doc id, since imported weeks
  // like "legacy-summer-w1" won't sort correctly against real date-based night ids).
  const weeksSorted = [...S.weekly].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  if (!S.viewWeekId && weeksSorted.length) S.viewWeekId = weeksSorted[weeksSorted.length - 1].id;
  const viewedWeek = weeksSorted.find((w) => w.id === S.viewWeekId) || null;
  const weekSel = weeksSorted.slice().reverse().map((w) =>
    `<option value="${esc(w.id)}"${w.id === S.viewWeekId ? ' selected' : ''}>${esc(w.date)}${w.week ? ' · Week ' + esc(w.week) : ''}</option>`).join('');

  let preview = '<p class="hint">Create a night first.</p>';
  let saved = null;
  if (night && S.statsMatches) {
    saved = S.weekly.find((w) => w.id === night.id);
    const rows = weeklyRows({ night, matches: S.statsMatches, players: S.players, rules: R, teamNames: S.config.teamNames });
    const results = matchResults([...S.statsMatches].sort((a, b) => parseInt(a.id.slice(1)) - parseInt(b.id.slice(1))), R);
    preview = `
      <div class="cols2">
        <div><h2 style="font-size:18px">Match results</h2><table>
          <thead><tr><th>Match</th><th class="num">Team</th><th class="num">Pts</th><th class="num">Pts</th><th class="num">Team</th></tr></thead>
          <tbody>${results.map((r) => `<tr><td>${esc(r.id.slice(1))}${r.complete ? '' : ' <span class="pill">in progress</span>'}</td>
            <td class="num">${r.teamA}</td><td class="num">${fmtPoints(r.a)}</td><td class="num">${fmtPoints(r.b)}</td><td class="num">${r.teamB}</td></tr>`).join('')}</tbody></table></div>
        <div><h2 style="font-size:18px">This night's totals</h2><p class="hint">${rows.length} players have thrown darts. ${saved ? `Last saved ${esc(new Date(saved.savedAt).toLocaleString())}.` : '<b>Not saved to season stats yet.</b>'}</p></div>
      </div>
      <div class="table-scroll" style="margin-top:12px"><table>
        <thead><tr><th class="num">Team</th><th>Player</th><th>G</th><th class="num">Games</th><th class="num">Points</th><th class="num">Shots</th><th class="num">Avg</th><th class="num">Fin</th><th class="num">HS</th><th class="num">HF</th><th class="num">100+/95+</th><th class="num">180/171</th></tr></thead>
        <tbody>${rows.map((r) => `<tr><td class="num">${r.team}</td><td>${esc(r.player)}${r.spare ? ' <span class="pill">spare</span>' : ''}</td><td>${r.gender[0]}</td>
          <td class="num">${r.games}</td><td class="num">${r.points}</td><td class="num">${r.shots}</td><td class="num">${r.average === null ? '' : r.average.toFixed(2)}</td>
          <td class="num">${r.finishes}</td><td class="num">${r.highShot}</td><td class="num">${r.highFinish || ''}</td><td class="num">${r.tons}</td><td class="num">${r.maxes}</td></tr>`).join('')}</tbody></table></div>`;
  } else if (night) {
    preview = '<p class="hint">Loading…</p>';
  }

  // Season standings from saved weeks (each team counted once per week)
  const perTeam = new Map();
  for (const w of S.weekly) {
    const seen = new Set();
    for (const r of w.rows || []) {
      if (seen.has(r.teamNum)) continue;
      seen.add(r.teamNum);
      const t = perTeam.get(r.teamNum) || { nights: 0, win: 0, total: 0 };
      t.nights += 1; t.win += r.win; t.total += r.total;
      perTeam.set(r.teamNum, t);
    }
  }
  const standings = [...perTeam.entries()].sort((a, b) => b[1].win - a[1].win);

  // Player stats from saved weeks (season-to-date, across every saved snapshot)
  const perPlayer = new Map();
  for (const w of S.weekly) {
    for (const r of w.rows || []) {
      const p = perPlayer.get(r.player) || {
        player: r.player, gender: r.gender, spare: r.spare, team: r.team,
        nights: 0, games: 0, points: 0, shots: 0, finishes: 0, highShot: 0, highFinish: 0, tons: 0, maxes: 0,
      };
      p.nights += 1;
      p.games += r.games || 0;
      p.points += r.points || 0;
      p.shots += r.shots || 0;
      p.finishes += r.finishes || 0;
      p.highShot = Math.max(p.highShot, r.highShot || 0);
      p.highFinish = Math.max(p.highFinish, r.highFinish || 0);
      p.tons += r.tons || 0;
      p.maxes += r.maxes || 0;
      p.team = r.team; p.spare = r.spare;   // reflects the most recently saved week
      perPlayer.set(r.player, p);
    }
  }
  const playerStandings = [...perPlayer.values()]
    .map((p) => ({ ...p, average: p.shots ? p.points / p.shots : null }))
    .sort((a, b) => (b.average ?? -1) - (a.average ?? -1));

  return `
    <div class="card">
      <h2>Save a night's stats</h2>
      <p class="hint">When the night is finished, save it. That stores the night's player stats and team points (the same columns as your "All Weeks" sheet) so they roll into the season totals.
        You can save again any time after a correction — it simply replaces that night's snapshot.</p>
      <div class="row">
        <div><label class="f">Night</label><select id="stats-night">${nightSel}</select></div>
        <button class="btn good" data-act="save-weekly" ${night ? '' : 'disabled'}>Save this night's stats</button>
        <button class="btn" data-act="csv-night" ${night ? '' : 'disabled'}>Download this night (CSV)</button>
        <button class="btn" data-act="csv-season" ${S.weekly.length ? '' : 'disabled'}>Download whole season (CSV)</button>
        <button class="btn" data-act="build-report" ${night && S.weekly.length && S.report.state !== 'building' ? '' : 'disabled'}>Build report (Excel + PDF)</button>
      </div>
      ${reportPanel()}
      ${preview}
    </div>
    <div class="card">
      <h2>View a saved week</h2>
      <p class="hint">Pick any saved week — nights you've played live, or weeks imported from before switching to this app — to see that week's player stats.</p>
      <div class="row"><div><label class="f">Week</label><select id="view-week-select">${weekSel}</select></div></div>
      ${viewedWeek ? `<div class="table-scroll" style="margin-top:12px"><table>
        <thead><tr><th class="num">Team</th><th>Player</th><th>G</th><th class="num">Games</th><th class="num">Points</th><th class="num">Shots</th><th class="num">Avg</th><th class="num">Fin</th><th class="num">HS</th><th class="num">HF</th><th class="num">100+/95+</th><th class="num">180/171</th></tr></thead>
        <tbody>${(viewedWeek.rows || []).map((r) => `<tr><td class="num">${r.team}</td><td>${esc(r.player)}${r.spare ? ' <span class="pill">spare</span>' : ''}</td><td>${(r.gender || '')[0] || ''}</td>
          <td class="num">${r.games}</td><td class="num">${r.points}</td><td class="num">${r.shots}</td><td class="num">${r.average == null ? '' : Number(r.average).toFixed(2)}</td>
          <td class="num">${r.finishes}</td><td class="num">${r.highShot}</td><td class="num">${r.highFinish || ''}</td><td class="num">${r.tons}</td><td class="num">${r.maxes}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="hint">No saved weeks yet.</p>'}
    </div>
    <div class="card">
      <h2>Season standings (saved weeks)</h2>
      ${standings.length ? `<table><thead><tr><th class="num">Rank</th><th class="num">Team</th><th>Team / players</th><th class="num">Nights</th><th class="num">Points</th><th class="num">Out of</th></tr></thead><tbody>
        ${standings.map(([t, v], i) => `<tr><td class="num">${i + 1}</td><td class="num">${t}</td><td>${esc(teamText(t))}</td><td class="num">${v.nights}</td><td class="num">${fmtPoints(v.win)}</td><td class="num">${fmtPoints(v.total)}</td></tr>`).join('')}
      </tbody></table>` : '<p class="hint">Standings appear after you save your first night.</p>'}
    </div>
    <div class="card">
      <h2>Player stats (saved weeks)</h2>
      <p class="hint">Season-to-date, combining every saved week — including any you imported from before switching to this app.</p>
      ${playerStandings.length ? `<div class="table-scroll"><table>
        <thead><tr><th class="num">Rank</th><th>Player</th><th class="num">Team</th><th class="num">Nights</th><th class="num">Games</th><th class="num">Avg</th><th class="num">HS</th><th class="num">HF</th><th class="num">Fin</th><th class="num">100+/95+</th><th class="num">180/171</th></tr></thead><tbody>
        ${playerStandings.map((p, i) => `<tr><td class="num">${i + 1}</td><td>${esc(p.player)}${p.spare ? ' <span class="pill">spare</span>' : ''}</td><td class="num">${p.team}</td><td class="num">${p.nights}</td><td class="num">${p.games}</td><td class="num">${p.average === null ? '' : p.average.toFixed(2)}</td><td class="num">${p.highShot}</td><td class="num">${p.highFinish || ''}</td><td class="num">${p.finishes}</td><td class="num">${p.tons}</td><td class="num">${p.maxes}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="hint">Player stats appear after you save your first night.</p>'}
    </div>`;
}

function download(filename, text) {
  const blob = new Blob(['\ufeff' + text], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
}

/* Status of the "Build report" button. Kept in S.report (not in the DOM) so a re-render can't wipe the links. */
function reportPanel() {
  const r = S.report;
  if (r.state === 'building') return '<p class="hint">Building the report… this takes about 30–60 seconds, and you can keep working.</p>';
  if (r.state === 'error') return `<p class="hint"><b>Couldn't build the report:</b> ${esc(r.msg)}</p>`;
  if (r.state !== 'done') return '';
  const links = r.downloads.map((d) =>
    `<a href="${esc(d.url)}"${d.name ? ` download="${esc(d.name)}"` : ''}${d.newTab ? ' target="_blank" rel="noopener"' : ''}>${esc(d.label)}</a>`).join(' · ');
  return `<p class="hint"><b>Report ready:</b> ${links}${r.warnings.map((w) => `<br><b>Warning:</b> ${esc(w)}`).join('')}</p>`;
}

/* Builds the Excel + PDF report from the same two CSVs the download buttons produce. */
async function buildReport() {
  const night = S.nights.find((n) => n.id === S.statsNight);
  if (!night || S.report.state === 'building') return;
  if (!S.weekly.length) return toast("Save this night's stats first — the report needs season data", 'error');
  if (!S.weekly.some((w) => w.id === night.id) && !window.confirm(
    "This night isn't saved to season stats yet, so the Season page of the report won't include it.\n\nBuild the report anyway? (Cancel, then click \"Save this night's stats\" first.)")) return;

  const nightRows = weeklyRows({ night, matches: S.statsMatches || [], players: S.players, rules: withRules(S.config.rules), teamNames: S.config.teamNames });
  const seasonRows = S.weekly.flatMap((w) => w.rows || []);
  revokeDownloads(S.report.downloads);
  S.report = { state: 'building' };
  render(true);
  try {
    const data = await requestReport(toCsv(nightRows), toCsv(seasonRows));
    S.report = { state: 'done', downloads: reportDownloads(data), warnings: data.warnings || [] };
  } catch (err) {
    console.error(err);
    S.report = { state: 'error', msg: err.message || String(err) };
  }
  render();
}

/* ========================================================== tab: settings == */

function settingsTab() {
  const d = S.draft;
  const num = (id, label, val, step = '1') => `<div><label class="f">${label}</label><input type="number" id="${id}" step="${step}" value="${esc(val)}" style="width:110px"></div>`;
  return `
    <div class="card">
      <h2>League</h2>
      <div class="row"><div style="flex:1;min-width:260px"><label class="f">League name (TV board title)</label><input type="text" id="s-name" value="${esc(d.name)}" style="width:100%"></div></div>
      <label class="f">TV ticker messages — one per line (birthdays, sponsors, reminders)</label>
      <textarea id="s-news">${esc(d.news)}</textarea>
      <p class="hint" style="margin-top:8px">Highlights like 180s, 100+ shots and big finishes are added to the ticker automatically.</p>
    </div>
    <div class="card">
      <h2>Scoring rules</h2>
      <p class="hint">Your current rules are the defaults. Changing these recalculates stats and points from the saved turns, so change them only if the league rules change.</p>
      <div class="row">
        ${num('s-legs', 'Legs per match', d.legsPerMatch)}
        ${num('s-fin', 'Points for finishing', d.finishPoints, '0.5')}
        ${num('s-u100', 'Points for under 100 first', d.under100Points, '0.5')}
        ${num('s-tonm', 'Men: 100+ counts from', d.tonM)}
        ${num('s-tonf', 'Women: 95+ counts from', d.tonF)}
        ${num('s-badge', 'Big-finish badge from', d.finishBadge)}
      </div>
      <div class="row" style="align-items:center;margin-top:2px">
        <label><input type="checkbox" id="s-avgunder100" ${d.avgExcludesUnder100 ? 'checked' : ''}>
          Stop counting shots toward average once a player is under 100 remaining</label>
      </div>
      <p class="hint" style="margin-top:6px">Some leagues only count "big scoring" turns toward average, treating anything thrown while chasing a finish under 100 as separate. Games, Points, Shots, Finishes and High Shot/Finish are never affected — only Average.</p>
      <button class="btn primary" data-act="save-settings">Save settings</button>
      ${S.kind === 'demo' ? '<button class="btn danger" data-act="reset-demo" style="margin-left:10px">Reset demo data</button>' : ''}
    </div>`;
}

async function saveSettings() {
  const v = (id) => $(id).value;
  const rules = {
    ...DEFAULT_RULES, ...(S.config.rules || {}),
    legsPerMatch: Math.max(1, parseInt(v('#s-legs'), 10) || 7),
    finishPoints: parseFloat(v('#s-fin')) || 0,
    under100Points: parseFloat(v('#s-u100')) || 0,
    tonThreshold: { M: parseInt(v('#s-tonm'), 10) || 100, F: parseInt(v('#s-tonf'), 10) || 95 },
    finishBadge: parseInt(v('#s-badge'), 10) || 95,
    avgExcludesUnder100: $('#s-avgunder100').checked,
  };
  const news = v('#s-news').split('\n').map((s) => s.trim()).filter(Boolean);
  await S.store.saveConfig({ name: v('#s-name').trim() || 'Dart League', news, rules });
  S.draft = null;
  toast('Settings saved', 'good');
  render(true);
}

/* ================================================================ events == */

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.closest('tr[data-pid]')) { S.dirty.add(t.closest('tr').dataset.pid); t.closest('tr').classList.add('dirty'); }
  if (S.tab === 'settings' && S.draft) {
    const map = { 's-name': 'name', 's-news': 'news', 's-legs': 'legsPerMatch', 's-fin': 'finishPoints', 's-u100': 'under100Points', 's-tonm': 'tonM', 's-tonf': 'tonF', 's-badge': 'finishBadge' };
    if (map[t.id]) S.draft[map[t.id]] = t.value;
    if (t.id === 's-avgunder100') S.draft.avgExcludesUnder100 = t.checked;
  }
  if (t.id === 'f-date') S.form.date = t.value;
  if (t.id === 'f-week') S.form.week = t.value;
});

document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.closest('tr[data-pid]')) { S.dirty.add(t.closest('tr').dataset.pid); t.closest('tr').classList.add('dirty'); }
  if (t.dataset && t.dataset.pair !== undefined) S.form.pairs[Number(t.dataset.pair)][Number(t.dataset.side)] = t.value;
  if (t.id === 'f-current') S.form.makeCurrent = t.checked;
  if (t.id === 'show-spares') { S.showSpares = t.checked; render(true); }
  if (t.id === 'stats-night') { watchStatsNight(t.value); render(true); }
  if (t.id === 'view-week-select') { S.viewWeekId = t.value; render(true); }
  if (t.dataset && t.dataset.f === 'spare') {
    const tr = t.closest('tr');
    tr.querySelector('[data-f="team"]').disabled = t.checked;
  }
});

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'tab': S.tab = el.dataset.tab; S.dirty.clear(); return render(true);
      case 'create-night': return createNight();
      case 'load-night': {
        const n = S.nights.find((x) => x.id === el.dataset.id);
        if (!n) return;
        const total = Math.max(S.form.pairs.length, (n.matches || []).length);
        S.form = {
          date: n.date, week: n.week || '', makeCurrent: true,
          pairs: Array.from({ length: total }, (_, i) => (n.matches && n.matches[i] ? [String(n.matches[i].a), String(n.matches[i].b)] : ['', ''])),
        };
        S.msg.night = null;
        window.scrollTo({ top: 0, behavior: 'smooth' });
        return render(true);
      }
      case 'make-current':
        await S.store.saveConfig({ currentNight: el.dataset.id });
        return toast('Now showing on the board and scorer tablets', 'good');
      case 'save-player': return savePlayerRow(el.dataset.id);
      case 'delete-player': {
        const p = S.players.find((x) => x.id === el.dataset.id);
        if (p && window.confirm(`Delete ${p.name}?\n\nIf they have played, consider un-ticking "Active" instead — that hides them from lineups but keeps their history.`)) {
          await S.store.deletePlayer(p.id); toast('Deleted');
        }
        return;
      }
      case 'add-player': return addPlayer();
      case 'load-seed': return loadSeed();
      case 'save-weekly': {
        const doc = await S.store.saveWeekly(S.statsNight);
        return toast(`Saved ${doc.rows.length} player rows for ${doc.date}`, 'good');
      }
      case 'csv-night': {
        const night = S.nights.find((n) => n.id === S.statsNight);
        const rows = weeklyRows({ night, matches: S.statsMatches || [], players: S.players, rules: withRules(S.config.rules), teamNames: S.config.teamNames });
        return download(`stats-${night.date}.csv`, toCsv(rows));
      }
      case 'csv-season': {
        const rows = S.weekly.flatMap((w) => w.rows || []);
        return download(`all-weeks-${todayISO()}.csv`, toCsv(rows));
      }
      case 'build-report': return buildReport();
      case 'save-settings': return saveSettings();
      case 'save-team-names': return saveTeamNames();
      case 'reset-demo':
        if (window.confirm('Erase all demo data in this browser and start over?')) {
          await S.store.resetDemo(); S.form = null; S.draft = null; toast('Demo data reset');
        }
        return;
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong', 'error');
  }
});
