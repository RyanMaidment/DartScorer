/* ==========================================================================
   Leg-by-leg score sheets — what every player threw in every leg, by week.

   Pure functions (no browser, no database): admin/legsheet.js loads the
   nights + matches and shows what renderLegSheets() returns. The turns come
   straight from the match records, replayed with lib/engine.js, so busts,
   finishes, "under 100 first" and leg points match the scorer exactly.

   Only nights scored in this app have turns. Weeks imported from the old
   spreadsheet only have totals, so they don't appear here.
   ========================================================================== */

import { withRules, matchState, lineupFor, playerStats, fmtPoints } from './engine.js';
import { teamTitle, customTeamName } from './night.js';

export const matchNo = (m) => parseInt(String(m.id).replace(/\D/g, ''), 10) || 0;

const hasTurns = (m) =>
  Object.values((m && m.legs) || {}).some((l) => (l && l.a && l.a.length) || (l && l.b && l.b.length));

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Sort key for a night: by week number, nights without one go last. */
const weekKey = (w) => (w.week === null || w.week === undefined || w.week === '' || !isFinite(Number(w.week)) ? Infinity : Number(w.week));

/**
 * Everything the sheets need, sorted by week (then date), matches by number.
 * Returns { R, weeks: [{ id, date, week, matches: [matchSheet] }] }
 */
export function buildLegSheets({ nights, matchesByNight, players, config }) {
  const R = withRules(config && config.rules);
  const byId = Object.fromEntries((players || []).map((p) => [p.id, p]));
  const weeks = (nights || [])
    .map((night) => {
      const matches = (matchesByNight[night.id] || [])
        .filter(hasTurns)
        .sort((a, b) => matchNo(a) - matchNo(b))
        .map((m) => matchSheet(m, byId, R, config));
      return { id: night.id, date: night.date || night.id, week: night.week ?? null, matches };
    })
    .filter((w) => w.matches.length)
    .sort((a, b) => (weekKey(a) - weekKey(b)) || String(a.date).localeCompare(String(b.date)));
  return { R, weeks };
}

function matchSheet(m, byId, R, config) {
  const ms = matchState(m, R);
  const stats = playerStats([m], byId, R);
  const tonFor = (p) => R.tonThreshold[p && p.gender === 'F' ? 'F' : 'M'];

  const legs = ms.legs.map((l) => ({
    n: l.n,
    played: l.started,
    starter: l.state.starter,
    winner: l.state.winner,
    under100First: l.state.under100First,
    pts: l.state.pts,
    left: { A: l.state.A.remaining, B: l.state.B.remaining },
    turns: { A: l.state.A.turns, B: l.state.B.turns },
  }));

  const side = (S) => {
    const team = S === 'A' ? m.teamA : m.teamB;
    // Who threw for this team: lineup order first (incl. substitutions), then anyone else who threw.
    const order = [];
    const add = (id) => { if (id && !order.includes(id)) order.push(id); };
    for (let n = 1; n <= R.legsPerMatch; n++) lineupFor(m, n, S).forEach(add);
    legs.forEach((l) => l.turns[S].forEach((t) => add(t.p)));

    const rows = order.map((pid) => {
      const p = byId[pid];
      const cells = legs.map((l) => l.turns[S]
        .map((t, i) => ({ ...t, i: i + 1 }))
        .filter((t) => t.p === pid)
        .map((t) => ({ s: t.s, bust: !!t.bust, finish: !!t.finish, max: R.maxShots.includes(t.s), ton: t.s >= tonFor(p), i: t.i, rem: t.rem })));
      const st = stats.get(pid);
      return {
        pid,
        name: p ? p.name : pid,
        dummy: !!(p && p.dummy),
        spare: !!(p && p.spare),
        cells,
        turns: cells.reduce((n, c) => n + c.length, 0),
        avg: st && st.avg !== null && st.avg !== undefined ? st.avg : null,
      };
    }).filter((r) => r.turns > 0);

    return {
      key: S,
      team,
      title: teamTitle(config, team),
      custom: !!customTeamName(config, team),
      points: S === 'A' ? ms.a : ms.b,
      rows,
    };
  };

  return {
    id: m.id,
    no: matchNo(m),
    status: m.status === 'final' || ms.complete ? 'final' : 'live',
    legs,
    A: side('A'),
    B: side('B'),
  };
}

/** Every team that appears in the sheets, for the team filter. [{ team, title }] */
export function teamsIn({ weeks }) {
  const map = new Map();
  weeks.forEach((w) => w.matches.forEach((m) => [m.A, m.B].forEach((s) => { if (!map.has(s.team)) map.set(s.team, s.title); })));
  return [...map.entries()].map(([team, title]) => ({ team, title })).sort((a, b) => a.team - b.team);
}

/** Keeps only some nights and/or one team's matches. */
export function filterSheets(model, { nightId = 'all', team = 'all' } = {}) {
  const t = team === 'all' ? null : Number(team);
  return {
    R: model.R,
    weeks: model.weeks
      .filter((w) => nightId === 'all' || w.id === nightId)
      .map((w) => ({ ...w, matches: t === null ? w.matches : w.matches.filter((m) => m.A.team === t || m.B.team === t) }))
      .filter((w) => w.matches.length),
  };
}

export function longDate(iso) {
  const d = /^\d{4}-\d{2}-\d{2}$/.test(String(iso)) ? new Date(iso + 'T12:00:00') : new Date(iso);
  return isNaN(d) ? String(iso || '') : d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/* ================================================================ render == */

/** HTML for the printable sheets (styles live in admin/legsheet.html). */
export function renderLegSheets({ R, weeks }, { leagueName = 'Dart League', builtOn = new Date() } = {}) {
  if (!weeks.length) {
    return `<div class="empty"><h2>No scored matches to show</h2>
      <p>Only nights scored in this app have turn-by-turn scores. Weeks imported from the old spreadsheet only have totals, so they can't appear here.</p></div>`;
  }
  const built = builtOn.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  return weeks.map((w, wi) => `
    <section class="week${wi === 0 ? ' first' : ''}">
      <header class="week-head">
        <div class="league">${esc(leagueName)} · Leg-by-leg scores</div>
        <h2>${w.week !== null && w.week !== '' ? `Week ${esc(w.week)}` : 'Week —'}<span>${esc(longDate(w.date))}</span></h2>
        ${legend(R)}
      </header>
      ${w.matches.map((m) => matchHtml(m, R)).join('')}
      <footer class="week-foot">Built ${esc(built)} from the scoring app · Averages are 3-dart averages${R.avgExcludesUnder100 ? '; turns thrown with under ' + R.underThreshold + ' remaining are not counted' : ''}.</footer>
    </section>`).join('');
}

function legend(R) {
  return `<div class="legend">
    <span><i class="t fin">40</i> finish</span>
    <span><i class="t max">180</i> 180 / 171</span>
    <span><i class="t ton">100</i> 100+ (men) / 95+ (women)</span>
    <span><i class="t bust">bust</i> bust (scores 0)</span>
    <span><b>▶</b> threw first in the leg</span>
    <span><b>U</b> under ${R.underThreshold} first</span>
  </div>`;
}

function matchHtml(m, R) {
  const legsHead = m.legs.map((l) => {
    const first = l.played ? `<small>▶ ${esc(teamShort(m[l.starter]))}</small>` : '<small>&nbsp;</small>';
    return `<th class="leg">Leg ${l.n}${first}</th>`;
  }).join('');
  const status = m.status === 'final' ? '<span class="status final">Final</span>' : '<span class="status live">Not finished</span>';
  return `
    <article class="match">
      <div class="match-head">
        <span class="mno">Match ${m.no}</span>
        <span class="team-a">${esc(m.A.title)}</span>
        <span class="score">${fmtPoints(m.A.points)} <i>:</i> ${fmtPoints(m.B.points)}</span>
        <span class="team-b">${esc(m.B.title)}</span>
        ${status}
      </div>
      <table class="sheet">
        <colgroup><col class="c-who">${m.legs.map(() => '<col class="c-leg">').join('')}<col class="c-avg"></colgroup>
        <thead><tr><th class="who">Player</th>${legsHead}<th class="avg">Avg</th></tr></thead>
        ${sideHtml(m, 'A', R)}
        ${sideHtml(m, 'B', R)}
      </table>
    </article>`;
}

const teamShort = (side) => (side.custom ? side.title : `T${side.team}`);

function sideHtml(m, S, R) {
  const sd = m[S];
  const width = m.legs.length + 2;
  const head = `<tr class="side-head"><th colspan="${width}"><span>${esc(sd.title)}</span>${sd.custom ? ` <small>Team ${sd.team}</small>` : ''}<b>${fmtPoints(sd.points)} pts</b></th></tr>`;
  const rows = sd.rows.length ? sd.rows.map((r) => `
      <tr>
        <td class="who">${esc(r.name)}${r.spare ? ' <em>spare</em>' : ''}${r.dummy ? ' <em>dummy</em>' : ''}</td>
        ${r.cells.map((c, i) => `<td class="turns">${m.legs[i].played ? (c.length ? c.map(turnHtml).join(' ') : '<span class="none">–</span>') : ''}</td>`).join('')}
        <td class="avg">${r.avg === null ? '–' : r.avg.toFixed(2)}</td>
      </tr>`).join('')
    : `<tr><td class="who none" colspan="${width}">No turns entered</td></tr>`;
  const result = m.legs.map((l) => {
    if (!l.played) return '<td class="res"></td>';
    const pts = l.pts[S];
    const bits = [];
    if (l.winner === S) bits.push('<b class="won">Won</b>');
    else bits.push(`<span class="left">${l.left[S]} left</span>`);
    if (l.under100First === S) bits.push('<b class="u">U</b>');
    bits.push(`<span class="pts${pts ? ' got' : ''}">+${fmtPoints(pts)}</span>`);
    return `<td class="res">${bits.join(' ')}</td>`;
  }).join('');
  return `<tbody class="side side-${S.toLowerCase()}">${head}${rows}
      <tr class="result"><td class="who">Leg result</td>${result}<td class="avg"><b>${fmtPoints(sd.points)}</b></td></tr>
    </tbody>`;
}

function turnHtml(t) {
  const cls = t.bust ? 'bust' : t.finish ? 'fin' : t.max ? 'max' : t.ton ? 'ton' : '';
  return `<i class="t ${cls}" title="Turn ${t.i} · ${t.rem} left">${t.bust ? 'bust' : t.s}</i>`;
}

/* =================================================================== csv == */

/** One row per turn, for Excel: Week, Date, Match, Leg, Team, Player, Turn, Score, … */
export function turnsCsv({ weeks }) {
  const head = ['Week', 'Date', 'Match', 'Leg', 'Team #', 'Team', 'Threw first', 'Turn', 'Player', 'Score', 'Bust', 'Finish', 'Remaining'];
  const out = [head];
  weeks.forEach((w) => w.matches.forEach((m) => m.legs.forEach((l) => {
    if (!l.played) return;
    ['A', 'B'].forEach((S) => {
      const sd = m[S];
      const nameOf = (pid) => { const r = sd.rows.find((x) => x.pid === pid); return r ? r.name : pid; };
      l.turns[S].forEach((t, i) => out.push([
        w.week ?? '', w.date, m.no, l.n, sd.team, sd.title, l.starter === S ? 'Yes' : '', i + 1,
        nameOf(t.p), t.s, t.bust ? 'Yes' : '', t.finish ? 'Yes' : '', t.rem,
      ]));
    });
  })));
  const cell = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  return out.map((r) => r.map(cell).join(',')).join('\r\n');
}
