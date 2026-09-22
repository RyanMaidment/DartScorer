/* ==========================================================================
   Tournament Scorer
   Scores one tie at a time (URL: #/t/:tournamentId/tie/:tieId), reached from
   the "Score" links on the Tournament Admin page. Turn-by-turn scoring reuses
   lib/engine.js exactly as the league scorer does — legs, busts, checkouts,
   turn rotation all work identically for 1, 2 or 3 player entries. What's
   different from the league: no setup screen (an entry's lineup is fixed
   when the tie is created), no team names, no substitutions, and a tie is
   decided by legs won, not league bonus points.
   ========================================================================== */

import { createTournamentStore } from '../../lib/tournament-store.js';
import { tieLegsWon } from '../../lib/tournament.js';
import {
  matchState, legState, starterFor, lineupFor, nextPlayer, lastThrower,
  classifyEntry, replaySide, fmtPoints,
} from '../../lib/engine.js';

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const keyOf = (side) => (side === 'A' ? 'a' : 'b');

const QUICK_SCORES = [26, 41, 45, 60, 100, 180];

const S = {
  store: null, kind: null,
  tournamentId: null, tieId: null,
  tournament: null, entries: null, tie: null,
  viewLeg: null, entry: '', override: null,
  pending: false, online: navigator.onLine,
};
let unsubT = null, unsubE = null, unsubTie = null;

boot();

async function boot() {
  try { S.store = await createTournamentStore(); }
  catch (err) {
    console.error(err);
    $('#app').innerHTML = `<div class="center-msg"><h2>Couldn't start</h2>${esc(err.message || err)}<br><br>Check <code>lib/config.js</code> and your internet connection.</div>`;
    return;
  }
  S.kind = S.store.kind;
  readHash();
  window.addEventListener('hashchange', () => { readHash(); render(); });
  window.addEventListener('online', () => { S.online = true; render(); });
  window.addEventListener('offline', () => { S.online = false; render(); });
  render();
}

function readHash() {
  const m = location.hash.match(/^#\/t\/([\w-]+)\/tie\/([\w-]+)/);
  const tid = m ? m[1] : null;
  const tieId = m ? m[2] : null;
  if (tid !== S.tournamentId || tieId !== S.tieId) {
    watch(tid, tieId);
    S.viewLeg = null; S.entry = ''; S.override = null;
  }
  S.tournamentId = tid; S.tieId = tieId;
}

function watch(tid, tieId) {
  if (unsubT) unsubT();
  if (unsubE) unsubE();
  if (unsubTie) unsubTie();
  S.tournament = null; S.entries = null; S.tie = null;
  if (!tid || !tieId) return;
  unsubT = S.store.onTournament(tid, (t) => { S.tournament = t; render(); });
  unsubE = S.store.onEntries(tid, (e) => { S.entries = e; render(); });
  unsubTie = S.store.onTie(tid, tieId, (t, meta) => { S.tie = t; S.pending = !!(meta && meta.pending); render(); });
}

/* ================================================================== helpers == */

const rules = () => ({ legsPerMatch: (S.tournament && S.tournament.legsPerMatch) || 5 });
const entryById = (id) => (S.entries || []).find((e) => e.id === id);

/* ================================================================== render == */

function render() {
  const app = $('#app');
  if (!S.tournamentId || !S.tieId) {
    app.innerHTML = `<div class="center-msg"><h2>No tie selected</h2>Open a "Score" link from the Tournament Admin page.</div>`;
    return;
  }
  if (!S.tournament || !S.entries || S.tie === null) {
    app.innerHTML = `<div class="center-msg">Loading…</div>`;
    return;
  }
  if (!S.tie) {
    app.innerHTML = `<div class="center-msg"><h2>Couldn't find this tie</h2>It may have been removed. Go back to the Tournament Admin page and try the link again.</div>`;
    return;
  }
  app.innerHTML = tieView();
  document.querySelectorAll('.turns').forEach((el) => { el.scrollTop = el.scrollHeight; });
}

function topbar({ title = '', mid = '', right = '' }) {
  return `<header class="topbar"><div class="title">${title}</div>${mid}${right}<button class="fullscreen-toggle" data-act="fullscreen" title="Toggle fullscreen (F)" aria-label="Toggle fullscreen"><svg viewBox="0 0 24 24" width="18" height="18"><path fill="currentColor" d="M4 9V4h5v2H6v3H4zm10-5h5v5h-2V6h-3V4zM4 15h2v3h3v2H4v-5zm14 3v-3h2v5h-5v-2h3z"/></svg></button></header>`;
}

function toggleFullscreen() {
  if (!document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  else document.exitFullscreen?.();
}

function syncHtml() {
  const cls = !S.online ? 'off' : S.pending ? 'saving' : '';
  const text = !S.online ? 'Offline — saving on this device' : S.pending ? 'Saving…' : 'Saved';
  return `${S.kind === 'demo' ? '<span class="demo-flag">DEMO</span>' : ''}<span class="sync ${cls}" title="${text}"><i></i><span class="sync-text">${text}</span></span>`;
}

let toastTimer = null;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

/* ------------------------------------------------------------ tie screen -- */

function viewedLeg(ms, R) {
  if (S.viewLeg && S.viewLeg <= R.legsPerMatch) return S.viewLeg;
  return ms.currentLeg;
}

function tieView() {
  const tie = S.tie;
  const R = rules();
  const ms = matchState(tie, R);
  const n = viewedLeg(ms, R);
  const leg = (tie.legs && tie.legs[n]) || { a: [], b: [] };
  const st = legState(leg, starterFor(tie, n), R);

  const legChips = ms.legs.map((l) => {
    const cls = [l.state.winner === 'A' ? 'wa' : l.state.winner === 'B' ? 'wb' : '', l.n === n ? 'cur' : ''].join(' ');
    return `<button class="legchip ${cls}" data-act="leg" data-n="${l.n}" aria-label="Leg ${l.n}">${l.n}</button>`;
  }).join('');

  const nameA = (entryById(tie.entryA) || {}).name || 'Entry A';
  const nameB = (entryById(tie.entryB) || {}).name || 'Entry B';

  const bar = topbar({
    title: `${esc(nameA)} <small>v ${esc(nameB)} · ${esc(tie.stage === 'knockout' ? 'Knockout' : 'Group')}</small>`,
    mid: `<div class="legbar">${legChips}</div>`,
    right: syncHtml(),
  });

  return bar + `<div class="match-grid">
    ${entryPanel(tie, 'A', n, leg, st, R, nameA)}
    ${padPanel(tie, n, leg, st, ms, R)}
    ${entryPanel(tie, 'B', n, leg, st, R, nameB)}
  </div>`;
}

function currentThrower(tie, n, leg, st) {
  if (st.over) return null;
  const side = st.next;
  const lineup = lineupFor(tie, n, side);
  const pid = (S.override && lineup.includes(S.override)) ? S.override : nextPlayer(lineup, leg[keyOf(side)]);
  return { side, pid, lineup };
}

function entryPanel(tie, side, n, leg, st, R, name) {
  const sd = st[side];
  const lineup = lineupFor(tie, n, side);
  const thrower = currentThrower(tie, n, leg, st);
  const chipsLive = !!thrower && thrower.side === side;
  const active = !st.over && st.next === side;
  const legsWon = side === 'A' ? tieLegsWon(tie, R).a : tieLegsWon(tie, R).b;
  const showPicker = lineup.length > 1;   // singles: nobody to pick between

  const tags = [
    active ? '<span class="tag throw">\u25b6 Throwing</span>' : '',
    st.winner === side ? '<span class="tag throw">Leg won</span>' : '',
  ].join('');

  const chips = showPicker ? lineup.map((p) => {
    const sel = chipsLive && p === thrower.pid;
    return chipsLive
      ? `<button class="pchip ${sel ? 'sel' : ''}" data-act="pick" data-p="${esc(p)}">${esc(p)}</button>`
      : `<span class="pchip static">${esc(p)}</span>`;
  }).join('') : '';

  const turns = sd.turns.map((t, i) => {
    const cls = [t.finish ? 'fin' : '', t.bust ? 'bust' : '', R.maxShots.includes(t.s) ? 'max' : (t.s >= R.tonThreshold.M ? 'ton' : '')].join(' ');
    const who = lineup.length > 1 ? `<span class="who">${esc(t.p)}</span>` : '';
    return `<span class="tchip ${cls}">${who}<b>${t.s}</b></span>`;
  }).join('');

  const numCls = sd.finished ? 'done' : (sd.remaining < R.underThreshold ? 'under' : '');

  return `
    <section class="team ${side === 'B' ? 'b' : ''} ${active ? 'active' : ''} panel-${side.toLowerCase()}">
      <div class="team-head">
        <div class="names">${esc(name)}</div>
        <div class="legs">${legsWon}<small>LEGS</small></div>
      </div>
      <div class="remaining">
        <div class="lbl">Remaining</div>
        <div class="num ${numCls}">${sd.remaining}</div>
      </div>
      <div class="tags">${tags}</div>
      ${chips ? `<div class="pchips">${chips}</div>` : ''}
      <div class="turns-label"><span>Turns (${sd.shots})</span></div>
      <div class="turns">${turns || '<span style="color:var(--chalk-dim);font-size:13px">No turns yet</span>'}</div>
    </section>`;
}

function padPanel(tie, n, leg, st, ms, R) {
  const t = currentThrower(tie, n, leg, st);
  const myShots = st.A.shots + st.B.shots;
  const undoBtn = `<button class="btn" data-act="undo" ${myShots > 0 ? '' : 'disabled'}>\u21b6 Undo last turn</button>`;

  if (!t) {
    const nameOf = (side) => (entryById(side === 'A' ? tie.entryA : tie.entryB) || {}).name || `Entry ${side}`;
    const legsWon = tieLegsWon(tie, R);
    const legLabel = (side) => `<div>${esc(nameOf(side))}<b>${side === 'A' ? legsWon.a : legsWon.b} legs</b></div>`;
    const winnerName = nameOf(st.winner);

    let action;
    if (legsWon.complete) {
      action = tie.stage === 'knockout'
        ? `<button class="btn good" style="font-size:18px" data-act="finish-knockout">Confirm result — advance bracket \u2713</button>`
        : `<div class="result-card" style="border-color:var(--brass)"><h3 style="color:var(--brass)">Tie complete</h3></div>`;
    } else {
      action = '<button class="btn good" style="font-size:20px" data-act="nextleg">Next leg \u203a</button>';
    }
    const matchLine = legsWon.complete
      ? `<h3 style="color:var(--brass)">${legsWon.a > legsWon.b ? esc(nameOf('A')) : esc(nameOf('B'))} wins the tie</h3><div style="font-family:var(--font-mono);font-size:34px;font-weight:700">${legsWon.a} \u2013 ${legsWon.b}</div>`
      : '';

    return `<section class="pad">
      <div class="result-card">
        <h3>Leg ${n} \u2014 ${esc(winnerName)} wins</h3>
        <div class="split">${legLabel('A')}${legLabel('B')}</div>
        ${matchLine}
        ${action}
      </div>
      <div class="pad-actions">${undoBtn}</div>
    </section>`;
  }

  const rem = st[t.side].remaining;
  const noTurns = st.A.shots + st.B.shots === 0;
  const starter = starterFor(tie, n);
  const nameOf = (side) => (entryById(side === 'A' ? tie.entryA : tie.entryB) || {}).name || `Entry ${side}`;
  const starterRow = noTurns ? `
    <div class="starter-row">Leg ${n} starts:
      <div class="seg">
        <button class="${starter === 'A' ? 'on' : ''}" data-act="set-starter" data-side="A">${esc(nameOf('A'))}</button>
        <button class="${starter === 'B' ? 'on b' : ''}" data-act="set-starter" data-side="B">${esc(nameOf('B'))}</button>
      </div></div>` : '';

  const who = `${esc(nameOf(t.side))}${t.lineup.length > 1 ? ` \u00b7 <b>${esc(t.pid)}</b>` : ''} to throw \u00b7 ${rem} left`;

  return `<section class="pad">
    <div class="entry-box">
      <div class="who">${who}</div>
      <div class="val ${S.entry === '' ? 'empty' : ''}" id="entry-val">${S.entry === '' ? '0' : esc(S.entry)}</div>
    </div>
    <div class="quick">${QUICK_SCORES.map((q) => `<button data-act="quick" data-v="${q}">${q}</button>`).join('')}</div>
    <div class="keys">
      ${[7, 8, 9, 4, 5, 6, 1, 2, 3].map((d) => `<button data-act="key" data-k="${d}">${d}</button>`).join('')}
      <button class="back" data-act="key" data-k="back" aria-label="Backspace">\u232b</button>
      <button data-act="key" data-k="0">0</button>
      <button class="enter" data-act="enter">Enter \u2713</button>
    </div>
    ${starterRow}
    <div class="pad-actions">${undoBtn}</div>
  </section>`;
}

/* ================================================================== keypad == */

function entryContext() {
  if (!S.tie) return null;
  const R = rules();
  const ms = matchState(S.tie, R);
  const n = viewedLeg(ms, R);
  const leg = (S.tie.legs && S.tie.legs[n]) || { a: [], b: [] };
  const st = legState(leg, starterFor(S.tie, n), R);
  const thrower = currentThrower(S.tie, n, leg, st);
  return { tie: S.tie, R, ms, n, leg, st, thrower };
}

function updateEntryDisplay() {
  const el = $('#entry-val');
  if (!el) return;
  el.textContent = S.entry === '' ? '0' : S.entry;
  el.classList.toggle('empty', S.entry === '');
}

function press(k) {
  const ctx = entryContext();
  if (!ctx || !ctx.thrower) return;
  if (k === 'back') { S.entry = S.entry.slice(0, -1); }
  else if (/^\d$/.test(k)) {
    const next = (S.entry === '0' ? '' : S.entry) + k;
    if (next.length > 3) return;
    if (parseInt(next, 10) > 180) { toast('The highest possible score is 180', 'error'); return; }
    S.entry = next;
  }
  updateEntryDisplay();
}

async function enterScore() {
  const ctx = entryContext();
  if (!ctx || !ctx.thrower) return;
  const { n, st, thrower } = ctx;
  if (S.entry === '') { toast('Type the score first (0 if they missed)', 'error'); return; }
  const s = parseInt(S.entry, 10);
  const rem = st[thrower.side].remaining;
  const c = classifyEntry(rem, s);

  if (c.kind === 'invalid') { toast(c.reason, 'error'); return; }
  if (c.kind === 'bust') {
    await commitTurn(ctx, thrower, 0, true);
    toast(`Bust \u2014 ${c.reason}. Recorded 0.`, 'error');
    return;
  }
  if (c.kind === 'finish') {
    const ok = await confirmModal({
      title: 'Finished the leg?',
      text: `${thrower.pid} checks out on ${s}. Was it a double?`,
      yes: `Yes, finished on ${s}`, no: 'No \u2014 fix score',
    });
    if (!ok) return;
    await commitTurn(ctx, thrower, s, false);
    toast(`Leg ${n} finished! \u{1F3AF}`, 'good');
    return;
  }
  await commitTurn(ctx, thrower, s, false);
}

async function commitTurn(ctx, thrower, s, bust) {
  const { tie, n, leg } = ctx;
  const key = keyOf(thrower.side);
  const turn = { p: thrower.pid, s, t: Date.now() };
  if (bust) turn.bust = true;
  const turns = [...(leg[key] || []), turn];
  S.entry = '';
  S.override = null;
  S.viewLeg = n;
  try {
    await S.store.writeTieTurns(S.tournamentId, S.tieId, n, thrower.side, turns);
  } catch (err) {
    console.error(err);
    toast('Could not save that turn \u2014 check the connection and try again', 'error');
  }
  render();
}

async function undoLast() {
  const ctx = entryContext();
  if (!ctx) return;
  const { tie, n, leg, st } = ctx;
  const side = lastThrower(st);
  if (!side) return;
  const key = keyOf(side);
  const turns = (leg[key] || []).slice(0, -1);
  S.viewLeg = n;
  S.entry = '';
  try {
    await S.store.writeTieTurns(S.tournamentId, S.tieId, n, side, turns);
    toast('Last turn removed');
  } catch (err) {
    toast('Could not undo \u2014 try again', 'error');
  }
  render();
}

/* ================================================================== modals == */

let modalResolve = null;

function showModal(html) {
  const d = $('#modal');
  d.innerHTML = html;
  if (!d.open) d.showModal();
}
function closeModal(result = false) {
  const d = $('#modal');
  if (modalResolve) { const r = modalResolve; modalResolve = null; r(result); }
  if (d.open) d.close();
}
$('#modal').addEventListener('close', () => {
  if (!$('#modal').open && modalResolve) { const r = modalResolve; modalResolve = null; r(false); }
});

function confirmModal({ title, text, yes = 'Yes', no = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    modalResolve = resolve;
    showModal(`
      <h3>${esc(title)}</h3>
      <p>${esc(text)}</p>
      <div class="row">
        <button class="btn" data-mact="no">${esc(no)}</button>
        <button class="btn ${danger ? 'danger' : 'good'}" data-mact="yes">${esc(yes)}</button>
      </div>`);
  });
}

/* -------------------------------------------------------- knockout finish -- */

async function finishKnockout() {
  const tie = S.tie;
  const R = rules();
  const { a, b, complete } = tieLegsWon(tie, R);
  if (!complete || a === b) return;
  const winnerEntry = a > b ? tie.entryA : tie.entryB;
  const winnerName = (entryById(winnerEntry) || {}).name || 'the winner';
  const ok = await confirmModal({
    title: 'Confirm the result?',
    text: `${winnerName} wins ${Math.max(a, b)}\u2013${Math.min(a, b)}. This advances the bracket and can't be an accidental tap \u2014 make sure the score above is right.`,
    yes: 'Confirm & advance', no: 'Wait',
  });
  if (!ok) return;
  try {
    await S.store.recordKnockoutResult(S.tournamentId, tie.round, tie.slot, winnerEntry);
    toast('Result recorded \u2014 bracket advanced', 'good');
  } catch (err) {
    toast(err.message || 'Could not advance the bracket', 'error');
  }
}

/* ================================================================== events == */

document.addEventListener('click', async (e) => {
  const mact = e.target.closest('[data-mact]');
  if (mact) {
    const act = mact.dataset.mact;
    if (act === 'yes') return closeModal(true);
    if (act === 'no') return closeModal(false);
    return;
  }

  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  const ctx = entryContext();

  switch (act) {
    case 'fullscreen': return toggleFullscreen();
    case 'leg': S.viewLeg = parseInt(el.dataset.n, 10); S.entry = ''; S.override = null; return render();
    case 'key': return press(el.dataset.k);
    case 'quick': S.entry = el.dataset.v; return updateEntryDisplay();
    case 'enter': return enterScore();
    case 'undo': return undoLast();
    case 'pick': S.override = el.dataset.p; return render();
    case 'nextleg': {
      if (!ctx) return;
      const { ms, n, R } = ctx;
      S.viewLeg = n < R.legsPerMatch ? n + 1 : ms.currentLeg;
      S.entry = ''; S.override = null;
      return render();
    }
    case 'set-starter': {
      if (!ctx) return;
      await S.store.setTieFields(S.tournamentId, S.tieId, { legs: { [ctx.n]: { starter: el.dataset.side } } });
      return;
    }
    case 'finish-knockout': return finishKnockout();
  }
});

// Physical keyboard support (laptops): digits, Backspace, Enter, F for fullscreen
document.addEventListener('keydown', (e) => {
  if ($('#modal').open) return;
  if (e.target && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
  if (e.key === 'f' || e.key === 'F') { toggleFullscreen(); return; }
  if (/^[0-9]$/.test(e.key)) press(e.key);
  else if (e.key === 'Backspace') { e.preventDefault(); press('back'); }
  else if (e.key === 'Enter') { e.preventDefault(); enterScore(); }
});
