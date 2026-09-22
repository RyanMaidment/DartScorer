/* ==========================================================================
   Dart Tournament — Admin
   Create a tournament, take entries, run the round-robin group stage, then
   generate and advance a single-elimination bracket. Entirely separate from
   the league (its own Firestore collection, via lib/tournament-store.js) —
   nothing here reads or writes league data.
   ========================================================================== */

import { createTournamentStore } from '../../lib/tournament-store.js';
import { groupStandings, tieLegsWon, champion } from '../../lib/tournament.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : '');

const S = {
  store: null, kind: null,
  tournaments: null,
  route: { name: 'list', id: null },
  current: null, entries: null, ties: null,
  msg: {},
};
let unsubT = null, unsubE = null, unsubTies = null;

boot();

async function boot() {
  try { S.store = await createTournamentStore(); }
  catch (err) { $('#app').innerHTML = `<div class="center"><h2>Couldn't start</h2>${esc(err.message || err)}</div>`; return; }
  S.kind = S.store.kind;
  readHash();
  window.addEventListener('hashchange', () => { readHash(); render(); });
  S.store.onTournaments((list) => { S.tournaments = list; render(); });
  render();
}

function readHash() {
  const m = location.hash.match(/^#\/t\/([\w-]+)/);
  const next = m ? { name: 'tournament', id: m[1] } : { name: 'list', id: null };
  if (next.id !== S.route.id) watchTournament(next.id);
  S.route = next;
}
const go = (h) => { location.hash = h; };

function watchTournament(id) {
  if (unsubT) unsubT();
  if (unsubE) unsubE();
  if (unsubTies) unsubTies();
  S.current = null; S.entries = null; S.ties = null;
  if (!id) return;
  unsubT = S.store.onTournament(id, (t) => { S.current = t; render(); });
  unsubE = S.store.onEntries(id, (e) => { S.entries = e; render(); });
  unsubTies = S.store.onTies(id, (t) => { S.ties = t; render(); });
}

function statusLabel(s) {
  return { entries: 'Taking entries', groups: 'Group stage', knockout: 'Knockout', complete: 'Complete' }[s] || s;
}

let toastTimer;
function toast(msg, type = '') {
  const t = $('#toast');
  t.textContent = msg; t.className = `show ${type}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = ''; }, 2800);
}

/* ================================================================= render == */

function render() {
  const app = $('#app');
  if (!S.tournaments) { app.innerHTML = '<div class="center">Loading…</div>'; return; }
  if (S.route.name === 'tournament') {
    if (!S.current || !S.entries || !S.ties) { app.innerHTML = '<div class="center">Loading…</div>'; return; }
    app.innerHTML = tournamentView();
    return;
  }
  app.innerHTML = listView();
}

function listView() {
  const rows = [...S.tournaments].sort((a, b) => b.createdAt - a.createdAt).map((t) => `
    <tr>
      <td>${esc(t.name)}</td>
      <td class="num">${esc(cap(t.format))}</td>
      <td><span class="pill ${t.status === 'complete' ? 'cur' : ''}">${esc(statusLabel(t.status))}</span></td>
      <td style="text-align:right"><a class="btn small" href="#/t/${esc(t.id)}">Open</a></td>
    </tr>`).join('');

  return `
    <div class="wrap">
      <header class="top">
        <h1>Dart Tournaments<small>ADMIN</small></h1>
        ${S.kind === 'demo' ? '<span class="flag">DEMO</span>' : ''}
      </header>
      <div class="card">
        <h2>New tournament</h2>
        <div class="row">
          <div><label class="f">Name</label><input type="text" id="nt-name" placeholder="e.g. Summer Singles Open" style="width:260px"></div>
          <div><label class="f">Format</label><select id="nt-format">
            <option value="singles">Singles</option>
            <option value="doubles">Doubles</option>
            <option value="triples">Triples</option>
          </select></div>
          <div><label class="f">Legs per tie</label><input type="number" id="nt-legs" min="1" value="5" style="width:90px"></div>
          <button class="btn primary" data-act="create-t">Create</button>
        </div>
        <div class="msg ${S.msg.create && S.msg.create.err ? 'err' : 'ok'}">${esc(S.msg.create ? S.msg.create.text : '')}</div>
      </div>
      <div class="card">
        <h2>Tournaments</h2>
        ${rows ? `<table><thead><tr><th>Name</th><th class="num">Format</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>` : '<p class="hint">No tournaments yet — create one above.</p>'}
      </div>
    </div>`;
}

function tournamentView() {
  const t = S.current;
  const bar = `<header class="top"><h1>${esc(t.name)}<small>${esc(cap(t.format))} · ${esc(statusLabel(t.status))}</small></h1>
    <a class="btn small" href="#/">‹ All tournaments</a></header>`;

  let body = '';
  if (t.status === 'entries') body = entriesSection() + startGroupsSection();
  else if (t.status === 'groups') body = groupsSection();
  else body = bracketSection();   // knockout or complete

  return `<div class="wrap">${bar}${body}</div>`;
}

/* ------------------------------------------------------------- entries -- */

function entriesSection() {
  const t = S.current;
  const perFormat = { singles: 1, doubles: 2, triples: 3 }[t.format] || 1;
  const list = [...S.entries].sort((a, b) => a.name.localeCompare(b.name));
  const rows = list.map((e) => `
    <tr><td>${esc(e.name)}</td><td style="text-align:right"><button class="btn small danger" data-act="del-entry" data-id="${esc(e.id)}">Remove</button></td></tr>`).join('');
  const nameInputs = Array.from({ length: perFormat }, (_, i) =>
    `<input type="text" class="ent-name" placeholder="Player ${i + 1} name" style="width:160px">`).join('');

  return `
    <div class="card">
      <h2>Entries (${list.length})</h2>
      <p class="hint">Open entry — type names fresh for this tournament, no roster link needed. ${perFormat === 1 ? 'One name per entry.' : `${perFormat} names per entry.`}</p>
      <div class="row">${nameInputs}<button class="btn primary" data-act="add-entry">Add entry</button></div>
      <div class="msg ${S.msg.entry && S.msg.entry.err ? 'err' : 'ok'}">${esc(S.msg.entry ? S.msg.entry.text : '')}</div>
      <div class="table-scroll" style="margin-top:10px"><table><tbody>${rows}</tbody></table></div>
    </div>`;
}

function startGroupsSection() {
  const n = S.entries.length;
  return `
    <div class="card">
      <h2>Start the group stage</h2>
      <p class="hint">${n} ${n === 1 ? 'entry' : 'entries'} so far. Pick how many groups, and how many advance from each group to the knockout bracket, then start — this locks entries and creates every group match.</p>
      <div class="row">
        <div><label class="f">Number of groups</label><input type="number" id="sg-groups" min="1" value="${Math.max(1, Math.round(n / 4))}" style="width:90px"></div>
        <div><label class="f">Advance per group</label><input type="number" id="sg-adv" min="1" value="2" style="width:90px"></div>
        <button class="btn good" data-act="start-groups" ${n < 2 ? 'disabled' : ''}>Start group stage</button>
      </div>
      ${n < 2 ? '<p class="hint">Add at least 2 entries first.</p>' : ''}
    </div>`;
}

/* --------------------------------------------------------------- groups -- */

function groupsSection() {
  const t = S.current;
  const entriesById = Object.fromEntries(S.entries.map((e) => [e.id, e]));
  const R = { legsPerMatch: t.legsPerMatch };
  const tiesByGroup = {};
  for (const tie of S.ties) { if (tie.stage === 'group') (tiesByGroup[tie.groupId] = tiesByGroup[tie.groupId] || []).push(tie); }

  const blocks = t.groups.map((g) => {
    const ties = tiesByGroup[g.id] || [];
    const standings = groupStandings(g.entryIds, ties, entriesById, R);
    const standRows = standings.map((r, i) => `
      <tr class="${i < t.advancePerGroup ? 'dirty' : ''}"><td class="num">${i + 1}</td><td>${esc(r.name)}</td><td class="num">${r.played}</td><td class="num">${r.won}</td><td class="num">${r.legsFor}-${r.legsAgainst}</td></tr>`).join('');
    const tieRows = ties.map((tie) => {
      const { a, b, complete, started } = tieLegsWon(tie, R);
      const nameA = (entriesById[tie.entryA] || {}).name || '?';
      const nameB = (entriesById[tie.entryB] || {}).name || '?';
      const status = complete ? `<b>${a}\u2013${b}</b> final` : started ? `${a}\u2013${b} in progress` : 'not started';
      return `<tr><td>${esc(nameA)}</td><td class="num">v</td><td>${esc(nameB)}</td>
        <td style="text-align:right;white-space:nowrap">${status} <a class="btn small" href="../score/#/t/${esc(t.id)}/tie/${esc(tie.id)}">Score</a></td></tr>`;
    }).join('');
    return `
      <div class="card">
        <h2>${esc(g.name)}</h2>
        <div class="cols2">
          <div>
            <h2 style="font-size:16px">Standings</h2>
            <table><thead><tr><th class="num">#</th><th>Entry</th><th class="num">P</th><th class="num">W</th><th class="num">Legs</th></tr></thead><tbody>${standRows}</tbody></table>
            <p class="hint" style="margin-top:6px">Highlighted rows are the top ${t.advancePerGroup} who'd advance right now.</p>
          </div>
          <div><h2 style="font-size:16px">Matches</h2><table><tbody>${tieRows}</tbody></table></div>
        </div>
      </div>`;
  }).join('');

  return blocks + `
    <div class="card">
      <h2>Move to the knockout bracket</h2>
      <p class="hint">Takes the top ${t.advancePerGroup} from each group above and seeds the bracket: group winners are placed first and kept apart from each other for as long as possible, then runners-up, and so on.</p>
      <button class="btn primary" data-act="start-knockout">Generate bracket</button>
    </div>`;
}

/* -------------------------------------------------------------- bracket -- */

function roundLabel(round, total) {
  const fromEnd = total - round;
  if (fromEnd === 0) return 'Final';
  if (fromEnd === 1) return 'Semifinals';
  if (fromEnd === 2) return 'Quarterfinals';
  return `Round ${round}`;
}

function bracketSection() {
  const t = S.current;
  const entriesById = Object.fromEntries(S.entries.map((e) => [e.id, e]));
  const tiesById = Object.fromEntries(S.ties.map((x) => [x.id, x]));
  const R = { legsPerMatch: t.legsPerMatch };
  const nameOf = (id) => (id ? ((entriesById[id] || {}).name || id) : 'BYE');
  const totalRounds = t.bracket.rounds.length;

  const rounds = t.bracket.rounds.map((round) => {
    const ties = round.ties.map((tie) => {
      if (tie.bye) return `<div class="bracket-tie bye"><div>${esc(nameOf(tie.winner))}</div><div class="vs">bye</div></div>`;
      if (!tie.entryA || !tie.entryB) return `<div class="bracket-tie pending"><div>?</div><div class="vs">v</div><div>?</div></div>`;
      const live = tie.tieId ? tiesById[tie.tieId] : null;
      const { a, b, complete } = live ? tieLegsWon(live, R) : { a: 0, b: 0, complete: false };
      const scoreLink = tie.tieId ? `<a class="btn small" href="../score/#/t/${esc(t.id)}/tie/${esc(tie.tieId)}">Score</a>` : '';
      const declare = !tie.winner ? `
        <div class="row">
          <button class="btn small" data-act="declare-winner" data-round="${round.round}" data-slot="${tie.slot}" data-entry="${esc(tie.entryA)}">${esc(nameOf(tie.entryA))} won</button>
          <button class="btn small" data-act="declare-winner" data-round="${round.round}" data-slot="${tie.slot}" data-entry="${esc(tie.entryB)}">${esc(nameOf(tie.entryB))} won</button>
        </div>` : '';
      return `<div class="bracket-tie ${tie.winner ? 'done' : ''}">
        <div class="${tie.winner === tie.entryA ? 'w' : ''}">${esc(nameOf(tie.entryA))}</div>
        <div class="vs">${complete ? `${a}\u2013${b}` : 'v'}</div>
        <div class="${tie.winner === tie.entryB ? 'w' : ''}">${esc(nameOf(tie.entryB))}</div>
        ${scoreLink}${declare}
      </div>`;
    }).join('');
    return `<div class="bracket-round"><h3>${esc(roundLabel(round.round, totalRounds))}</h3>${ties}</div>`;
  }).join('');

  const champ = champion(t.bracket);
  return `
    <div class="card">
      <h2>Bracket</h2>
      ${champ ? `<p class="hint" style="font-size:18px"><b style="color:var(--brass)">\u{1F3C6} Champion: ${esc(nameOf(champ))}</b></p>` : ''}
      <div class="bracket">${rounds}</div>
    </div>`;
}

/* ================================================================= actions == */

async function createTournament() {
  const name = $('#nt-name').value.trim();
  const format = $('#nt-format').value;
  const legsPerMatch = Math.max(1, parseInt($('#nt-legs').value, 10) || 5);
  if (!name) { S.msg.create = { err: true, text: 'Give it a name.' }; render(); return; }
  try {
    const t = await S.store.createTournament({ name, format, legsPerMatch });
    S.msg.create = null;
    go(`#/t/${t.id}`);
  } catch (err) {
    S.msg.create = { err: true, text: err.message || String(err) };
    render();
  }
}

async function addEntry() {
  const inputs = [...document.querySelectorAll('.ent-name')];
  const names = inputs.map((el) => el.value.trim());
  if (names.some((n) => !n)) { S.msg.entry = { err: true, text: 'Fill in every name field.' }; render(); return; }
  try {
    await S.store.addEntry(S.current.id, names);
    S.msg.entry = null;
    inputs.forEach((el) => { el.value = ''; });
    render();
  } catch (err) {
    S.msg.entry = { err: true, text: err.message || String(err) };
    render();
  }
}

async function startGroups() {
  const numGroups = Math.max(1, parseInt($('#sg-groups').value, 10) || 1);
  const advancePerGroup = Math.max(1, parseInt($('#sg-adv').value, 10) || 1);
  try {
    await S.store.startGroups(S.current.id, { numGroups, advancePerGroup });
    toast('Group stage started', 'good');
  } catch (err) {
    toast(err.message || 'Could not start the group stage', 'error');
  }
}

async function startKnockout() {
  const t = S.current;
  const entriesById = Object.fromEntries(S.entries.map((e) => [e.id, e]));
  const R = { legsPerMatch: t.legsPerMatch };
  const tiesByGroup = {};
  for (const tie of S.ties) { if (tie.stage === 'group') (tiesByGroup[tie.groupId] = tiesByGroup[tie.groupId] || []).push(tie); }

  // Seed order: every group's winner first, then every runner-up, and so on —
  // so entries from the same group are kept apart for as long as possible.
  const tiers = Array.from({ length: t.advancePerGroup }, () => []);
  for (const g of t.groups) {
    const standings = groupStandings(g.entryIds, tiesByGroup[g.id] || [], entriesById, R);
    standings.slice(0, t.advancePerGroup).forEach((row, rank) => tiers[rank].push(row.entryId));
  }
  const qualifiers = tiers.flat();
  if (qualifiers.length < 2) { toast('Need at least 2 qualifiers to start a bracket', 'error'); return; }
  try {
    await S.store.startKnockout(t.id, qualifiers);
    toast('Bracket created', 'good');
  } catch (err) {
    toast(err.message || 'Could not create the bracket', 'error');
  }
}

async function declareWinner(round, slot, entryId) {
  const t = S.current;
  const label = 'Record this result and advance the bracket?';
  if (!window.confirm(label)) return;
  try {
    await S.store.recordKnockoutResult(t.id, Number(round), Number(slot), entryId);
    toast('Result recorded', 'good');
  } catch (err) {
    toast(err.message || 'Could not advance the bracket', 'error');
  }
}

/* ================================================================== events == */

document.addEventListener('click', async (e) => {
  const el = e.target.closest('[data-act]');
  if (!el) return;
  const act = el.dataset.act;
  try {
    switch (act) {
      case 'create-t': return createTournament();
      case 'add-entry': return addEntry();
      case 'del-entry': {
        if (window.confirm('Remove this entry?')) await S.store.deleteEntry(S.current.id, el.dataset.id);
        return;
      }
      case 'start-groups': return startGroups();
      case 'start-knockout': return startKnockout();
      case 'declare-winner': return declareWinner(el.dataset.round, el.dataset.slot, el.dataset.entry);
    }
  } catch (err) {
    console.error(err);
    toast(err.message || 'Something went wrong', 'error');
  }
});
