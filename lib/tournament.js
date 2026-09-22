/* ==========================================================================
   Tournament engine — groups, standings, and knockout bracket.
   Pure functions (no Firestore, no DOM), same philosophy as lib/engine.js,
   which this module leans on directly for actually scoring a tie: a
   tournament tie is scored with matchState()/legState() exactly like a
   league match — nothing here reimplements turn-by-turn scoring. Singles,
   doubles and triples all just mean a lineup of 1, 2 or 3 names; nextPlayer()
   in engine.js already rotates through a lineup of any length.

   A tie's shape is deliberately the same as a league match's:
     { id, entryA, entryB, lineupA: [names], lineupB: [names], firstStarter,
       legs: { 1: { a: [...], b: [...] }, ... } }
   so matchState(tie, R), legState(...), lineupFor(tie, n, 'A') etc. all work
   on it unchanged. The only thing this file adds on top is turning legs won
   into a tie winner, and entries/groups/bracket into a shape.
   ========================================================================== */

import { matchState } from './engine.js';

/* ---------------------------------------------------------------- ids -- */

let counter = 0;
function makeId(prefix) {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter}`;
}

/** An entry is 1 (singles), 2 (doubles) or 3 (triples) player names, open-entry (no roster link). */
export function makeEntry(players) {
  const list = players.map((p) => String(p).trim()).filter(Boolean);
  return { id: makeId('e'), players: list, name: list.join(' & ') };
}

/* ------------------------------------------------------------- groups -- */

/**
 * Deals entries into `numGroups` groups as evenly as possible (dealt one at
 * a time in order, like dealing cards — group sizes differ by at most 1).
 */
export function generateGroups(entryIds, numGroups) {
  const n = Math.max(1, numGroups);
  const groups = Array.from({ length: n }, () => []);
  entryIds.forEach((id, i) => groups[i % n].push(id));
  return groups.map((ids, i) => ({ id: makeId('g'), name: `Group ${String.fromCharCode(65 + i)}`, entryIds: ids }));
}

/** Every entry in a group plays every other entry once. */
export function groupTies(entryIds) {
  const ties = [];
  for (let i = 0; i < entryIds.length; i++) {
    for (let j = i + 1; j < entryIds.length; j++) {
      ties.push({ id: makeId('t'), entryA: entryIds[i], entryB: entryIds[j] });
    }
  }
  return ties;
}

/** Legs won by each side of a scored tie (fixed legsPerMatch, most legs wins — no early stop). */
export function tieLegsWon(tie, R) {
  const ms = matchState(tie, R);
  let a = 0, b = 0;
  for (const leg of ms.legs) {
    if (leg.state.winner === 'A') a += 1;
    else if (leg.state.winner === 'B') b += 1;
  }
  return { a, b, complete: ms.complete, started: ms.started };
}

/** Tie winner's entry id, or null if not finished (or drawn — shouldn't happen with an odd legsPerMatch). */
export function tieWinner(tie, R) {
  const { a, b, complete } = tieLegsWon(tie, R);
  if (!complete || a === b) return null;
  return a > b ? tie.entryA : tie.entryB;
}

/**
 * Standings for one group, given its ties (each a scored tie as above).
 * Ranks by: matches won, then leg difference, then legs won, then name —
 * the last two are just to keep the order stable; a genuine tie for a
 * qualifying spot is for the admin to break by hand (head-to-head, a
 * decider leg, etc.), not something this guesses at.
 */
export function groupStandings(entryIds, ties, entriesById, R) {
  const row = (id) => ({
    entryId: id, name: (entriesById[id] || {}).name || id,
    played: 0, won: 0, lost: 0, legsFor: 0, legsAgainst: 0,
  });
  const rows = new Map(entryIds.map((id) => [id, row(id)]));

  for (const tie of ties) {
    const a = rows.get(tie.entryA), b = rows.get(tie.entryB);
    if (!a || !b) continue;
    const { a: la, b: lb, complete } = tieLegsWon(tie, R);
    if (!complete) continue;
    a.played += 1; b.played += 1;
    a.legsFor += la; a.legsAgainst += lb;
    b.legsFor += lb; b.legsAgainst += la;
    if (la > lb) { a.won += 1; b.lost += 1; } else if (lb > la) { b.won += 1; a.lost += 1; }
  }

  return [...rows.values()]
    .map((r) => ({ ...r, legDiff: r.legsFor - r.legsAgainst }))
    .sort((x, y) => y.won - x.won || y.legDiff - x.legDiff || y.legsFor - x.legsFor || x.name.localeCompare(y.name));
}

/* ------------------------------------------------------------ bracket -- */

/**
 * Classic single-elimination seeding order for a bracket of `size` (a power
 * of 2): keeps seed 1 and 2 apart as long as possible, then 3 and 4, etc.
 * e.g. size 8 -> [1,8,4,5,2,7,3,6], meaning bracket slot pairs are
 * (1 v 8), (4 v 5), (2 v 7), (3 v 6).
 */
export function seedOrder(size) {
  let order = [1];
  while (order.length < size) {
    const n = order.length * 2 + 1;
    order = order.flatMap((seed) => [seed, n - seed]);
  }
  return order;
}

/**
 * Builds a single-elimination bracket from a seeded list of qualifiers
 * (index 0 = seed 1, etc.). Pads to the next power of 2 with byes, which
 * are auto-resolved (and propagated) immediately — nobody has to "play" a
 * bye. Returns { size, rounds: [{ round, ties: [...] }, ...] }, where each
 * tie is { slot, entryA, entryB, bye, winner, tieId } — `tieId` is filled
 * in by the caller once a real (non-bye) tie document is created for it.
 */
export function initBracket(qualifiers) {
  const size = Math.max(2, 2 ** Math.ceil(Math.log2(Math.max(2, qualifiers.length))));
  const order = seedOrder(size);
  const bySeed = (seed) => (seed <= qualifiers.length ? qualifiers[seed - 1] : null);   // null = bye

  const round1 = [];
  for (let i = 0; i < size; i += 2) {
    const entryA = bySeed(order[i]);
    const entryB = bySeed(order[i + 1]);
    const bye = !entryA || !entryB;
    round1.push({ slot: i / 2, entryA, entryB, bye, winner: bye ? (entryA || entryB) : null, tieId: null });
  }

  const rounds = [{ round: 1, ties: round1 }];
  let prev = round1;
  let roundNum = 2;
  while (prev.length > 1) {
    const ties = [];
    for (let i = 0; i < prev.length; i += 2) {
      ties.push({ slot: i / 2, entryA: null, entryB: null, bye: false, winner: null, tieId: null });
    }
    rounds.push({ round: roundNum, ties });
    prev = ties;
    roundNum += 1;
  }

  // Propagate every already-decided bye forward before returning.
  for (let r = 0; r < rounds.length - 1; r++) {
    for (const tie of rounds[r].ties) {
      if (tie.winner) placeWinner(rounds, r, tie.slot, tie.winner);
    }
  }
  return { size, rounds };
}

/** Puts a round's winner into the correct slot of the next round. */
function placeWinner(rounds, roundIdx, slot, winnerEntryId) {
  const next = rounds[roundIdx + 1];
  if (!next) return;
  const nextTie = next.ties[Math.floor(slot / 2)];
  if (slot % 2 === 0) nextTie.entryA = winnerEntryId; else nextTie.entryB = winnerEntryId;
  // If that now completes ANOTHER bye (both slots filled but one was always a bye further
  // down — only possible with very small qualifier counts), it still needs a real tie played;
  // byes only ever occur in round 1, so there's nothing further to auto-resolve here.
}

/**
 * Call once a real (played) tie's winner is known. Records it on that tie
 * and pushes the winner into the next round's slot. Mutates `bracket` in
 * place and also returns it, for convenience.
 */
export function advanceBracket(bracket, roundNum, slot, winnerEntryId) {
  const round = bracket.rounds.find((r) => r.round === roundNum);
  if (!round) return bracket;
  const tie = round.ties[slot];
  if (!tie) return bracket;
  tie.winner = winnerEntryId;
  const roundIdx = bracket.rounds.indexOf(round);
  placeWinner(bracket.rounds, roundIdx, slot, winnerEntryId);
  return bracket;
}

/** The champion, once the final's winner is set — otherwise null. */
export function champion(bracket) {
  const final = bracket.rounds[bracket.rounds.length - 1];
  return (final && final.ties[0] && final.ties[0].winner) || null;
}
