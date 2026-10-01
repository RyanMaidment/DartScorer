/* Weekly stats snapshot (same columns as the "All Weeks" sheet) and CSV export. */

import { withRules, playerStats, matchResults, pointsPerMatch } from './engine.js';
import { teamLabel } from './night.js';

export const CSV_COLUMNS = [
  ['Team', 'team'], ['Gender', 'gender'], ['Player', 'player'], ['Games', 'games'], ['Points', 'points'],
  ['Shots', 'shots'], ['Average', 'average'], ['Finishes', 'finishes'], ['High Shot', 'highShot'],
  ['High Finish', 'highFinish'], ['100+ or 95+', 'tons'], ['180 or 171', 'maxes'], ['Team#', 'teamNum'],
  ['Team Name', 'teamName'], ['Win', 'win'], ['#', 'total'], ['Loss', 'loss'], ['Week', 'week'],
  ['Date', 'date'], ['Spare', 'spare'],
  // The points and turns that count toward Average. Same as Points/Shots unless the
  // "stop counting shots toward average once under 100" rule is on. Kept last so the
  // original "All Weeks" columns don't move.
  ['Avg Points', 'avgPoints'], ['Avg Shots', 'avgShots'],
  // 180s and 171s counted separately (there's an award for each). "180 or 171" above stays as the combined count.
  ['180s', 'max180'], ['171s', 'max171'],
];

const GENDER_WORD = { M: 'Male', F: 'Female' };

/**
 * One row per player who threw a dart on the night — the same information the
 * old "SAVE TO COMPLETE STATS SPREADSHEET" script appended to All Weeks.
 */
export function weeklyRows({ night, matches, players, rules, teamNames }) {
  const R = withRules(rules);
  const byId = Object.fromEntries(players.map((p) => [p.id, p]));
  const stats = playerStats(matches, byId, R);
  const teamPoints = {};
  for (const r of matchResults(matches, R)) { teamPoints[r.teamA] = r.a; teamPoints[r.teamB] = r.b; }
  const total = pointsPerMatch(R);

  return [...stats.values()]
    .filter((s) => s.shots > 0)
    .sort((a, b) => a.team - b.team || (byId[a.id].order ?? 0) - (byId[b.id].order ?? 0))
    .map((s) => {
      const win = teamPoints[s.team] ?? 0;
      return {
        team: s.team,
        gender: GENDER_WORD[s.gender] || 'N/A',
        player: s.name,
        games: s.games,
        points: s.points,
        shots: s.shots,
        average: s.avg,
        finishes: s.finishes,
        highShot: s.highShot,
        highFinish: s.highFinish,
        tons: s.tons,
        maxes: s.maxes,
        teamNum: s.team,
        teamName: (teamNames && teamNames[String(s.team)] && String(teamNames[String(s.team)]).trim()) || (teamLabel(players, s.team) + ' - TEAM'),
        win,
        total,
        loss: total - win,
        week: night.week ?? '',
        date: night.date,
        spare: s.spare ? 'Yes' : '',
        // `?? null`: the database rejects blank (undefined) values, so a missing number is saved as empty instead
        avgPoints: s.avgPoints ?? null,
        avgShots: s.avgShots ?? null,
        max180: s.max180 ?? null,
        max171: s.max171 ?? null,
      };
    });
}

/**
 * The points and turns a saved row contributes to a combined (season) average.
 * Rows saved with avgPoints/avgShots are exact. Older rows are rebuilt from Average × Shots:
 * exact when the under-100 rule is off, a close estimate when it's on (re-save the night to make it exact).
 */
export function avgParts(r) {
  const n = (v) => (v === null || v === undefined || v === '' ? null : Number(v));
  const ap = n(r.avgPoints), as = n(r.avgShots), avg = n(r.average), shots = n(r.shots);
  if (ap !== null && as !== null) return { points: ap, shots: as };
  if (avg !== null && shots) return { points: avg * shots, shots };
  if (avg === null && shots && n(r.points) !== null) return { points: n(r.points), shots };
  return { points: 0, shots: 0 };
}

const esc = (v) => {
  const s = v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function toCsv(rows) {
  const head = CSV_COLUMNS.map(([h]) => esc(h)).join(',');
  const body = rows.map((r) => CSV_COLUMNS.map(([, k]) => esc(k === 'average' && r[k] != null ? Number(r[k]).toFixed(4) : r[k])).join(','));
  return [head, ...body].join('\r\n');
}
