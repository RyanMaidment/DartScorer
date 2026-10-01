/* ==========================================================================
   Leg-by-leg score sheets (printable) — opened from Admin ▸ Stats & export.
   Loads every night's matches, then shows what each player threw in each
   leg, grouped by week. Print it, or "Save as PDF", for a file.
   Add ?night=YYYY-MM-DD to open on one night; ?demo works as on other pages.
   ========================================================================== */

import { requireAdminLogin } from '../lib/auth-gate.js';
import { createStore } from '../lib/store.js';
import { buildLegSheets, filterSheets, renderLegSheets, teamsIn, turnsCsv, longDate } from '../lib/legsheet-model.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const S = { model: null, league: 'Dart League', nightId: 'all', team: 'all' };

boot();

async function boot() {
  await requireAdminLogin($('#sheets'));      // same password (and remembered unlock) as the Admin page
  $('#sheets').innerHTML = '<p class="loading">Loading every night\u2019s scores\u2026</p>';
  try {
    const store = await createStore();
    const [nights, players, config] = await Promise.all([store.getNights(), store.getPlayers(), store.getConfig()]);
    const matchesByNight = {};
    await Promise.all(nights.map(async (n) => { matchesByNight[n.id] = await store.getMatches(n.id); }));
    S.league = (config && config.name) || 'Dart League';
    S.model = buildLegSheets({ nights, matchesByNight, players, config: config || {} });

    const q = new URLSearchParams(location.search);
    const wanted = q.get('night');
    if (wanted && S.model.weeks.some((w) => w.id === wanted)) S.nightId = wanted;
    if (q.get('team')) S.team = q.get('team');

    fillControls();
    $('.toolbar').hidden = false;
    draw();
  } catch (err) {
    console.error(err);
    $('#sheets').innerHTML = `<div class="empty"><h2>Couldn't load the scores</h2><p>${esc(err.message || err)}</p></div>`;
  }
}

function fillControls() {
  const weekLabel = (w) => `${w.week !== null && w.week !== '' ? `Week ${w.week}` : 'No week #'} \u2014 ${longDate(w.date)}`;
  $('#pick-night').innerHTML = `<option value="all">All weeks (${S.model.weeks.length})</option>`
    + S.model.weeks.map((w) => `<option value="${esc(w.id)}"${w.id === S.nightId ? ' selected' : ''}>${esc(weekLabel(w))}</option>`).join('');
  $('#pick-team').innerHTML = '<option value="all">All teams</option>'
    + teamsIn(S.model).map((t) => `<option value="${t.team}"${String(t.team) === String(S.team) ? ' selected' : ''}>${esc(t.title === `Team ${t.team}` ? t.title : `Team ${t.team} \u2014 ${t.title}`)}</option>`).join('');
}

function current() {
  return filterSheets(S.model, { nightId: S.nightId, team: S.team });
}

function draw() {
  const view = current();
  $('#sheets').innerHTML = renderLegSheets(view, { leagueName: S.league });
  // The title becomes the suggested file name when saving as PDF.
  const w = S.nightId === 'all' ? null : S.model.weeks.find((x) => x.id === S.nightId);
  const parts = ['Leg scores', w ? (w.week ? `Week ${w.week}` : w.date) : 'All weeks'];
  if (S.team !== 'all') parts.push(`Team ${S.team}`);
  document.title = parts.join(' - ');
  $('#print').disabled = !view.weeks.length;
  $('#csv').disabled = !view.weeks.length;
}

$('#pick-night').addEventListener('change', (e) => { S.nightId = e.target.value; draw(); });
$('#pick-team').addEventListener('change', (e) => { S.team = e.target.value; draw(); });
$('#print').addEventListener('click', () => window.print());
$('#csv').addEventListener('click', () => {
  const blob = new Blob(['\ufeff' + turnsCsv(current())], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${document.title}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1500);
});
