/* ==========================================================================
   Board model — turns tonight's matches + roster into exactly the data shape
   the TV board's render() functions expect (same as the old data.json):
     { meta, matches, awards, menTop8, womenTop8, news }
   Pure functions, so they can be tested without a browser.
   ========================================================================== */

import { withRules, matchState, lineupFor, playerStats, legState, starterFor } from './engine.js';
import { customTeamName } from './night.js';

/** "Ken MCLEAN" -> "Ken McLean", "Alain PATRY" -> "Alain Patry" */
export function prettyName(name) {
  return String(name || '').trim().split(/\s+/).map((w) => {
    if (w.length > 1 && w === w.toUpperCase() && /[A-Z]/.test(w)) {
      const cap = w.charAt(0) + w.slice(1).toLowerCase();
      return cap.replace(/^Mc([a-z])/, (_, c) => 'Mc' + c.toUpperCase());
    }
    return w;
  }).join(' ');
}

const matchNo = (m) => parseInt(String(m.id).replace(/\D/g, ''), 10) || 0;

function badgesFor(s, R) {
  const out = [];
  if (s.maxes > 0) out.push('\u{1F48E}');          // 💎  180 / 171
  else if (s.tons > 0) out.push('\u{1F4AF}');      // 💯  100+ (men) / 95+ (women)
  if (s.highFinish >= R.finishBadge) out.push('\u{1F3AF}');   // 🎯  big finish
  return out;
}

function rankList(rows, R, limit = 8) {
  const sorted = [...rows].sort((a, b) => {
    if ((b.avg ?? -1) !== (a.avg ?? -1)) return (b.avg ?? -1) - (a.avg ?? -1);
    return a.name.localeCompare(b.name);
  });
  return sorted.slice(0, limit).map((s, i) => ({
    rank: i + 1,
    name: prettyName(s.name),
    badges: badgesFor(s, R),
    avg: s.avg === null ? null : Math.round(s.avg * 10) / 10,
    hs: s.highShot,
    hfin: s.highFinish || null,
  }));
}

/**
 * MVP / SVP rating — a single 0–100 number built from four stats, so a big
 * average alone doesn't automatically win the night. Each stat is scaled
 * against the best value in the same gender's field tonight (0 = worst
 * tonight, 1 = best tonight), so average (~20–130), a single big shot
 * (0–180), a big checkout (0–170) and a small count of finishes are all
 * compared on equal footing before being weighted:
 *
 *   40% average     — the best overall measure of a full night's throwing
 *   20% high finish  — a big checkout is a real highlight
 *   20% high shot    — a big single turn is a real highlight
 *   20% finishes     — reliably being the one who closes out a leg
 *
 * The three highlight stats together (60%) outweigh average alone (40%),
 * so a standout night of finishes/big shots/big checkouts can beat someone
 * who simply averaged a few points higher — but an average lead still
 * matters, and a single so-so highlight won't flip a close race by itself.
 *
 * (Tune RATING_WEIGHTS, or replace pickAwards entirely, to change this.)
 */
const RATING_WEIGHTS = { avg: 0.4, highFinish: 0.2, highShot: 0.2, finishes: 0.2 };

function normalize(value, min, max) {
  if (max === min) return 1;   // everyone tied on this stat tonight
  return (value - min) / (max - min);
}

/** Adds a 0–100 `rating` to each row, scaled against the rest of this pool. */
function rate(rows) {
  const bounds = (key) => {
    const vals = rows.map((r) => r[key] || 0);
    return { min: Math.min(...vals), max: Math.max(...vals) };
  };
  const b = { avg: bounds('avg'), highFinish: bounds('highFinish'), highShot: bounds('highShot'), finishes: bounds('finishes') };

  return rows.map((r) => {
    const score =
      RATING_WEIGHTS.avg * normalize(r.avg || 0, b.avg.min, b.avg.max) +
      RATING_WEIGHTS.highFinish * normalize(r.highFinish || 0, b.highFinish.min, b.highFinish.max) +
      RATING_WEIGHTS.highShot * normalize(r.highShot || 0, b.highShot.min, b.highShot.max) +
      RATING_WEIGHTS.finishes * normalize(r.finishes || 0, b.finishes.min, b.finishes.max);
    return { ...r, rating: Math.round(score * 1000) / 10 };   // 0–100, one decimal
  });
}

export function pickAwards(menRows, womenRows) {
  const played = (rows) => rows.filter((r) => r.shots > 0);
  const ranked = (rows) => rate(played(rows)).sort((a, b) => b.rating - a.rating || (b.avg ?? 0) - (a.avg ?? 0) || a.name.localeCompare(b.name));
  const awards = [];
  const add = (title, gender, s) => s && awards.push({
    title, gender, name: prettyName(s.name), rating: s.rating, unit: 'rating',
  });
  const m = ranked(menRows), w = ranked(womenRows);
  add('MVP', 'men', m[0]);
  add('MVP', 'women', w[0]);
  add('SVP', 'men', m[1]);
  add('SVP', 'women', w[1]);
  return awards;
}

/**
 * Ticker flavor text for a good (non-max) score, picked from a message pool
 * keyed by score range — e.g. "Mike is on a hot streak with 118!". Add,
 * remove or edit ranges/messages here to change what the ticker says.
 *
 * The pick is deterministic per throw (seeded from that turn's own
 * timestamp), not re-rolled on every board refresh — otherwise the same
 * shot from 10 minutes ago would keep rewording itself every time the
 * board polls for updates.
 *
 * These ranges are independent of the "ton" threshold used for stats and
 * badges elsewhere (Admin → Settings): a score can light up the ticker here
 * without necessarily counting as a "ton" on the leaderboard, and vice versa.
 */
const SCORE_MESSAGE_RANGES = [
  {
    min: 80, max: 100,
    messages: [
      'has achieved a solid score of', 'has just hit a commendable', 'has reached a notable',
      'has accomplished a respectable', 'has recorded a strong', 'is cruising with a score of',
      'is on a roll with', 'is stacking up points with', 'is showing consistency with',
      'is throwing darts so well, even the board is applauding with',
      "is nailing the board like it's a DIY project gone right with",
      'is on target like a Parliament Hill tour guide with',
    ],
  },
  {
    min: 101, max: 139,
    messages: [
      'has achieved an impressive', 'has just hit an outstanding', 'has reached a remarkable',
      'has accomplished a fantastic', 'has recorded an excellent', 'is smashing it with',
      'is on a hot streak with', 'is racking up points like a shopper on Black Friday with',
      'is hitting new heights with', 'is making waves with',
      'is nailing the board like a carpenter on caffeine with',
      'is on target like a GPS with no recalculating with',
      'is on a target like a Tim Hortons drive-thru with no line with',
    ],
  },
  {
    min: 140, max: Infinity,
    messages: [
      'is on fire with an incredible', 'has achieved a phenomenal', 'has accomplished a legendary',
      'has reached an extraordinary', 'has recorded an unstoppable', 'is blazing through with',
      'is in beast mode like a grizzly bear in the wild with', 'is dominating with',
      'is rewriting the rulebook with', "is scoring triple 20s like it's clearance sale with",
      "is scoring triple 20s like it's their birthday wish with",
      "is scoring triple 20s like it's a poutine festival with",
    ],
  },
];

/** Small stable hash so the same turn (by timestamp) always maps to the same message. */
function hashSeed(n) {
  let x = Math.trunc(n) || 0;
  x = ((x >> 16) ^ x) * 0x45d9f3b;
  x = ((x >> 16) ^ x) * 0x45d9f3b;
  x = (x >> 16) ^ x;
  return Math.abs(x);
}

/** Picks a message for this score from the matching range bucket, or null if none fits. */
function scoreMessage(score, seed) {
  const bucket = SCORE_MESSAGE_RANGES.find((r) => score >= r.min && score <= r.max);
  if (!bucket) return null;
  return bucket.messages[hashSeed(seed) % bucket.messages.length];
}

/** Ticker lines: manual announcements first, then auto-generated highlights. */
export function buildNews({ config, matches, playersById, R }) {
  const manual = ((config && config.news) || []).map((s) => String(s).trim()).filter(Boolean);
  const events = [];
  for (const m of matches) {
    for (let n = 1; n <= R.legsPerMatch; n++) {
      const leg = (m.legs && m.legs[n]) || { a: [], b: [] };
      const st = legState(leg, starterFor(m, n), R);
      for (const side of ['A', 'B']) {
        (leg[side === 'A' ? 'a' : 'b'] || []).forEach((raw, i) => {
          const eff = st[side].turns[i];
          const p = playersById[raw.p];
          if (!eff || !p || p.dummy) return;
          events.push({ p, s: eff.s, finish: eff.finish, t: raw.t || 0 });
        });
      }
    }
  }
  const auto = [];
  const isMax = (e) => R.maxShots.includes(e.s);

  events.filter(isMax).sort((a, b) => b.t - a.t).slice(0, 4)
    .forEach((e) => auto.push(`\u{1F48E} ${e.p.short || e.p.name} hit a ${e.s}!`));

  events.filter((e) => !isMax(e))
    .map((e) => ({ e, msg: scoreMessage(e.s, e.t) }))
    .filter((x) => x.msg)
    .sort((a, b) => b.e.t - a.e.t)
    .slice(0, 4)
    .forEach(({ e, msg }) => auto.push(`\u{1F4AF} ${e.p.short || e.p.name} ${msg} ${e.s}!`));

  events.filter((e) => e.finish && e.s >= R.finishBadge).sort((a, b) => b.t - a.t).slice(0, 3)
    .forEach((e) => auto.push(`\u{1F3AF} ${e.p.short || e.p.name} checked out ${e.s}!`));

  return [...manual, ...auto];
}

export function buildBoardModel({ config, players, matches, rules }) {
  const R = withRules(rules || (config && config.rules));
  const playersById = Object.fromEntries(players.map((p) => [p.id, p]));
  const ordered = [...matches].sort((a, b) => matchNo(a) - matchNo(b));

  const boardMatches = ordered.map((m) => {
    const ms = matchState(m, R);
    const names = (side) => lineupFor(m, ms.currentLeg, side).map((id) => (playersById[id] ? (playersById[id].short || playersById[id].name) : '?'));
    // A custom team name replaces the list of player names on the TV.
    const label = (side) => {
      const custom = customTeamName(config, side === 'A' ? m.teamA : m.teamB);
      return custom ? [custom] : names(side);
    };
    return {
      teamANum: String(m.teamA), teamAPlayers: label('A'), scoreA: ms.a,
      teamBNum: String(m.teamB), teamBPlayers: label('B'), scoreB: ms.b,
    };
  });

  // Players appearing tonight (so the leaderboards can list them before they've thrown)
  const tonight = new Set();
  for (const m of ordered) {
    [...(m.lineupA || []), ...(m.lineupB || [])].forEach((id) => tonight.add(id));
    Object.values(m.legs || {}).forEach((l) => [...(l.lineupA || []), ...(l.lineupB || [])].forEach((id) => tonight.add(id)));
  }
  const stats = playerStats(ordered, playersById, R);
  const rowFor = (id) => {
    const p = playersById[id];
    if (!p || p.dummy) return null;
    return stats.get(id) || { id, name: p.name, short: p.short, gender: p.gender, team: p.team, shots: 0, avg: null, highShot: 0, highFinish: 0, finishes: 0, tons: 0, maxes: 0 };
  };
  const rows = [...tonight].map(rowFor).filter(Boolean);
  const men = rows.filter((r) => r.gender === 'M');            // spares with no gender set are left off until set in Admin
  const women = rows.filter((r) => r.gender === 'F');

  return {
    meta: { leagueName: (config && config.name) || 'Dart League' },
    matches: boardMatches,
    awards: pickAwards(men, women),
    menTop8: rankList(men, R),
    womenTop8: rankList(women, R),
    news: buildNews({ config, matches: ordered, playersById, R }),
  };
}
