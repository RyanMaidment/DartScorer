/* ==========================================================================
   Dart league scoring engine (pure functions, no browser / database code)
   --------------------------------------------------------------------------
   Everything the spreadsheet used to calculate lives here:

   - Turn-by-turn 501 replay (remaining score, busts, finishes)
   - "Under 100 first" (worked out from turn order — no manual checkbox)
   - Leg points: 1 for finishing + 0.5 for getting under 100 first
   - Player stats: Games, Points, Shots, Average, Finishes, High Shot,
     High Finish, 100+/95+ count, 180/171 count

   DATA SHAPE (what gets stored in the database):
     match = {
       teamA: 1, teamB: 3,
       lineupA: [playerId, playerId, playerId],   // default lineup
       lineupB: [...],
       firstStarter: 'A' | 'B',                   // who throws first in leg 1
       legs: {
         '1': { a: [{p: playerId, s: 60}, ...],   // Team A's turns, in order
                b: [{p: playerId, s: 45}, ...],   // Team B's turns, in order
                starter?: 'A'|'B',                // optional override
                lineupA?: [...], lineupB?: [...]  // substitution from this leg on
              },
         ...
       }
     }
   Only raw turns are stored. Everything else is calculated from them.
   ========================================================================== */

export const DEFAULT_RULES = {
  startScore: 501,
  legsPerMatch: 7,
  finishPoints: 1,          // for finishing (hitting the double) the leg
  under100Points: 0.5,      // for getting under 100 first
  underThreshold: 100,      // remaining must drop BELOW this
  tonThreshold: { M: 100, F: 95 },   // "100+ or 95+"  (men / women)
  maxShots: [180, 171],              // "180 or 171"
  playersPerTeam: 3,
  finishBadge: 95,          // TV badge for a finish this big or bigger
  avgExcludesUnder100: false,   // some leagues stop counting shots toward average once under 100 remains
};

export function withRules(r) {
  return { ...DEFAULT_RULES, ...(r || {}), tonThreshold: { ...DEFAULT_RULES.tonThreshold, ...((r && r.tonThreshold) || {}) } };
}

/** Points available per leg (finish + under-100), e.g. 1.5 */
export function pointsPerLeg(rules) {
  return rules.finishPoints + rules.under100Points;
}
/** Points available per match, e.g. 10.5 */
export function pointsPerMatch(rules) {
  return pointsPerLeg(rules) * rules.legsPerMatch;
}

/* ------------------------------------------------------ entry validation -- */

// Totals that cannot be scored with three darts.
const IMPOSSIBLE_SCORES = new Set([163, 166, 169, 172, 173, 175, 176, 178, 179]);
// Remaining scores that cannot be finished in three darts (double-out).
const BOGEY_CHECKOUTS = new Set([159, 162, 163, 165, 166, 168, 169]);

export function isPossibleScore(s) {
  return Number.isInteger(s) && s >= 0 && s <= 180 && !IMPOSSIBLE_SCORES.has(s);
}

export function isCheckout(remaining) {
  return Number.isInteger(remaining) && remaining >= 2 && remaining <= 170 && !BOGEY_CHECKOUTS.has(remaining);
}

/**
 * What would happen if a team with `remaining` points left scored `s`?
 *   { kind: 'ok' | 'finish' | 'bust' | 'invalid', reason? }
 * The app cannot see the dartboard, so it can't verify the double — it only
 * checks that the finish is arithmetically possible.
 */
export function classifyEntry(remaining, s) {
  if (!Number.isInteger(s) || s < 0 || s > 180) return { kind: 'invalid', reason: 'Enter a score from 0 to 180' };
  if (IMPOSSIBLE_SCORES.has(s)) return { kind: 'invalid', reason: `${s} can't be scored with 3 darts` };
  if (s === remaining) {
    return isCheckout(remaining)
      ? { kind: 'finish' }
      : { kind: 'bust', reason: `${remaining} can't be finished in 3 darts` };
  }
  if (s > remaining) return { kind: 'bust', reason: 'Over the remaining score' };
  if (remaining - s === 1) return { kind: 'bust', reason: 'Would leave 1' };
  return { kind: 'ok' };
}

/* ------------------------------------------------------------ leg replay -- */

/**
 * Replay one team's turns for a leg. Busts/invalid turns count as 0 (still a
 * shot). Turns after a finish are ignored.
 */
export function replaySide(turns, rules) {
  const R = withRules(rules);
  let rem = R.startScore;
  let points = 0;
  let crossedAt = null;           // 1-based turn number that first got under the threshold
  let finished = false;
  let finishScore = 0;
  const out = [];

  for (const t of turns || []) {
    if (finished) break;
    const raw = Number.isFinite(t.s) ? Math.trunc(t.s) : 0;
    const c = classifyEntry(rem, raw);
    let s = raw;
    let bust = false;
    if (c.kind === 'bust' || c.kind === 'invalid') { s = 0; bust = raw !== 0; }
    rem -= s;
    points += s;
    out.push({ p: t.p, s, bust, rem, finish: rem === 0 });
    if (crossedAt === null && rem < R.underThreshold) crossedAt = out.length;
    if (rem === 0) { finished = true; finishScore = s; }
  }

  return { turns: out, remaining: rem, points, shots: out.length, crossedAt, finished, finishScore };
}

const other = (side) => (side === 'A' ? 'B' : 'A');

/** Overall throw order position of a side's n-th (1-based) turn. Lower = earlier. */
function position(side, n, starter) {
  return (n - 1) * 2 + (side === starter ? 0 : 1);
}

/**
 * Full state of one leg.
 * `leg` = { a: [...], b: [...] };  `starter` = 'A' | 'B'
 */
export function legState(leg, starter, rules) {
  const R = withRules(rules);
  const st = starter === 'B' ? 'B' : 'A';
  const A = replaySide(leg && leg.a, R);
  const B = replaySide(leg && leg.b, R);

  // Winner = the side that finished (if data ever shows both, earlier wins).
  let winner = null;
  if (A.finished && B.finished) {
    winner = position('A', A.shots, st) < position('B', B.shots, st) ? 'A' : 'B';
  } else if (A.finished) winner = 'A';
  else if (B.finished) winner = 'B';

  // Under 100 first — compare who got there earlier in throw order.
  let under100First = null;
  if (A.crossedAt !== null && B.crossedAt !== null) {
    under100First = position('A', A.crossedAt, st) < position('B', B.crossedAt, st) ? 'A' : 'B';
  } else if (A.crossedAt !== null) under100First = 'A';
  else if (B.crossedAt !== null) under100First = 'B';

  // Whose turn is next: the side with fewer turns, the starter if level.
  let next = null;
  if (!winner) {
    if (A.shots === B.shots) next = st;
    else next = A.shots < B.shots ? 'A' : 'B';
  }

  const pts = { A: 0, B: 0 };
  if (winner) pts[winner] += R.finishPoints;
  if (under100First) pts[under100First] += R.under100Points;

  return { A, B, starter: st, over: !!winner, winner, under100First, next, pts };
}

/* --------------------------------------------------------- match helpers -- */

export function starterFor(match, n) {
  const leg = match && match.legs && match.legs[n];
  if (leg && (leg.starter === 'A' || leg.starter === 'B')) return leg.starter;
  const first = match && match.firstStarter === 'B' ? 'B' : 'A';
  return n % 2 === 1 ? first : other(first);   // legs alternate
}

/** Lineup for a side in leg n: latest substitution at or before n, else the match default. */
export function lineupFor(match, n, side) {
  const key = side === 'A' ? 'lineupA' : 'lineupB';
  for (let k = n; k >= 1; k--) {
    const leg = match.legs && match.legs[k];
    if (leg && Array.isArray(leg[key]) && leg[key].length) return leg[key];
  }
  return match[key] || [];
}

/** Default next thrower slot: the player after whoever threw last. */
export function nextPlayer(lineup, turns) {
  if (!lineup || !lineup.length) return null;
  const last = turns && turns.length ? turns[turns.length - 1] : null;
  if (!last) return lineup[0];
  const idx = lineup.indexOf(last.p);
  const nextIdx = idx === -1 ? turns.length % lineup.length : (idx + 1) % lineup.length;
  return lineup[nextIdx];
}

/**
 * Two-phone scoring: each team's marker enters its own throws, so one side can lag behind.
 * When a leg has been won, this is how many throws the OTHER side still has to enter
 * (the side that finished throws (winnerShots) times; the loser throws one fewer if the
 * winner threw first in the leg, otherwise the same number).
 */
export function legOwed(state, side) {
  if (!state.over || state.winner === side) return 0;
  const required = state[state.winner].shots - (state.starter === state.winner ? 1 : 0);
  return Math.max(0, required - state[side].shots);
}

/** Which side threw the most recent turn in a leg (null if no turns yet). */
export function lastThrower(state) {
  if (state.A.shots + state.B.shots === 0) return null;
  if (state.over) return state.winner;
  return state.next === state.starter ? other(state.starter) : state.starter;
}

/** State + points for every leg of a match. */
export function matchState(match, rules) {
  const R = withRules(rules);
  const legs = [];
  let a = 0, b = 0;
  for (let n = 1; n <= R.legsPerMatch; n++) {
    const leg = (match.legs && match.legs[n]) || { a: [], b: [] };
    const state = legState(leg, starterFor(match, n), R);
    legs.push({ n, state, started: state.A.shots + state.B.shots > 0 });
    a += state.pts.A;
    b += state.pts.B;
  }
  const openLeg = legs.find((l) => !l.state.over);
  return {
    legs,
    a,
    b,
    complete: !openLeg,
    // first leg that isn't finished (or the last leg if everything is done)
    currentLeg: openLeg ? openLeg.n : R.legsPerMatch,
    started: legs.some((l) => l.started),
  };
}

/* ---------------------------------------------------------- player stats -- */

/**
 * Aggregate stats per player over any set of matches.
 * Dummies are excluded (they don't affect anybody's average).
 * Returns a Map(playerId -> row).
 */
export function playerStats(matches, playersById, rules) {
  const R = withRules(rules);
  const stats = new Map();

  const rowFor = (p, teamNum) => {
    if (!stats.has(p.id)) {
      stats.set(p.id, {
        id: p.id, name: p.name, short: p.short || p.name, gender: p.gender, spare: !!p.spare,
        team: teamNum, games: 0, points: 0, shots: 0, finishes: 0,
        highShot: 0, highFinish: 0, tons: 0, maxes: 0, avg: null,
        avgPoints: 0, avgShots: 0,   // internal only — used to compute `avg`, stripped before returning
      });
    }
    return stats.get(p.id);
  };

  for (const match of matches) {
    const legsPlayed = {}; // playerId -> Set of leg numbers
    for (let n = 1; n <= R.legsPerMatch; n++) {
      const leg = (match.legs && match.legs[n]) || { a: [], b: [] };
      const state = legState(leg, starterFor(match, n), R);
      for (const side of ['A', 'B']) {
        const teamNum = side === 'A' ? match.teamA : match.teamB;
        let remBefore = R.startScore;   // remaining BEFORE the turn about to be processed
        for (const t of state[side].turns) {
          const p = playersById[t.p];
          if (!p || p.dummy) { remBefore = t.rem; continue; }
          const row = rowFor(p, teamNum);
          row.team = teamNum;
          row.shots += 1;
          row.points += t.s;
          // The turn that FIRST crosses under 100 still counts (it was thrown from >= 100);
          // only turns thrown while remaining was ALREADY under 100 are excluded from the average.
          if (!R.avgExcludesUnder100 || remBefore >= R.underThreshold) {
            row.avgShots += 1;
            row.avgPoints += t.s;
          }
          if (t.s > row.highShot) row.highShot = t.s;
          const ton = R.tonThreshold[p.gender === 'F' ? 'F' : 'M'];
          if (t.s >= ton) row.tons += 1;
          if (R.maxShots.includes(t.s)) row.maxes += 1;
          if (t.finish) {
            row.finishes += 1;
            if (t.s > row.highFinish) row.highFinish = t.s;
          }
          (legsPlayed[p.id] = legsPlayed[p.id] || new Set()).add(n);
          remBefore = t.rem;
        }
      }
    }
    for (const [pid, set] of Object.entries(legsPlayed)) stats.get(pid).games += set.size;
  }

  for (const row of stats.values()) {
    row.avg = row.avgShots ? row.avgPoints / row.avgShots : null;
    delete row.avgPoints;
    delete row.avgShots;
  }
  return stats;
}

/** Team points for each match: [{ teamA, teamB, a, b }] */
export function matchResults(matches, rules) {
  return matches.map((m) => {
    const ms = matchState(m, rules);
    return { id: m.id, teamA: m.teamA, teamB: m.teamB, a: ms.a, b: ms.b, complete: ms.complete };
  });
}

/* ---------------------------------------------------------------- names -- */

/** "Alain PATRY" -> "Alain P", "Kim WANNER BELL" -> "Kim WB" */
export function shortName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  if (/^S\.$/i.test(parts[0])) return String(full).trim();          // spares: "S. Paul Awalt"
  return parts[0] + ' ' + parts.slice(1).map((w) => w.charAt(0).toUpperCase()).join('');
}

export function slug(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
}

export function fmtPoints(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}
