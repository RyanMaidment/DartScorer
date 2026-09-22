/* ==========================================================================
   Tournament store — uses the exact same generic backend as the league
   (lib/backend.js: getDoc/getCollection/setDoc/updateDoc/deleteDoc/onDoc/
   onCollection, backed by either Firestore or the localStorage demo
   backend). Nothing here touches the league's collections — a tournament
   lives entirely under its own top-level `tournaments` collection, so
   running one never risks league data.

   Collections:
     tournaments/{id}                    name, format, status, group/bracket config
     tournaments/{id}/entries/{eid}      one doc per entry (1–3 player names, open entry)
     tournaments/{id}/ties/{tid}         one doc per tie — same turn-by-turn shape as a
                                          league match, so lib/engine.js scores it unchanged
   ========================================================================== */

import { getBackend } from './backend.js';
import { makeEntry, generateGroups, groupTies, initBracket, advanceBracket, champion } from './tournament.js';
import { slug } from './engine.js';

const tiePath = (tid, tieId) => `tournaments/${tid}/ties/${tieId}`;

function uniqueId(name) {
  const base = slug(name) || 'tournament';
  return `${base}-${Date.now().toString(36)}`;
}

export async function createTournamentStore() {
  const be = await getBackend();

  return {
    kind: be.kind,
    backend: be,

    /* ---- live subscriptions ---- */
    onTournaments: (cb) => be.onCollection('tournaments', cb),
    onTournament: (id, cb) => be.onDoc(`tournaments/${id}`, cb),
    onEntries: (id, cb) => be.onCollection(`tournaments/${id}/entries`, cb),
    onTies: (id, cb) => be.onCollection(`tournaments/${id}/ties`, cb),
    onTie: (id, tieId, cb) => be.onDoc(`tournaments/${id}/ties/${tieId}`, cb),

    /* ---- one-shot reads ---- */
    getTournaments: () => be.getCollection('tournaments'),
    getTournament: (id) => be.getDoc(`tournaments/${id}`),
    getEntries: (id) => be.getCollection(`tournaments/${id}/entries`),
    getTies: (id) => be.getCollection(`tournaments/${id}/ties`),

    /* ---- create ---- */
    async createTournament({ name, format, legsPerMatch = 5 }) {
      const id = uniqueId(name);
      const doc = {
        name: String(name || '').trim() || 'Tournament',
        format,                              // 'singles' | 'doubles' | 'triples'
        legsPerMatch,                        // fixed legs per tie, all played, most legs wins
        status: 'entries',                   // entries -> groups -> knockout -> complete
        numGroups: null, advancePerGroup: null,
        groups: null,                        // [{ id, name, entryIds }] once groups start
        bracket: null,                       // set by tournament.js's initBracket() once knockout starts
        createdAt: Date.now(),
      };
      await be.setDoc(`tournaments/${id}`, doc);
      return { id, ...doc };
    },

    /* ---- entries (open entry: just names, no roster link) ---- */
    async addEntry(tournamentId, players) {
      const entry = makeEntry(players);
      await be.setDoc(`tournaments/${tournamentId}/entries/${entry.id}`, entry);
      return entry;
    },
    deleteEntry: (tournamentId, entryId) => be.deleteDoc(`tournaments/${tournamentId}/entries/${entryId}`),

    /* ---- group stage ---- */
    /** Splits entries into groups, creates every round-robin tie document, and moves the
     *  tournament into 'groups' status. numGroups/advancePerGroup are set here, per tournament. */
    async startGroups(tournamentId, { numGroups, advancePerGroup }) {
      const entries = await be.getCollection(`tournaments/${tournamentId}/entries`);
      const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
      const groups = generateGroups(entries.map((e) => e.id), numGroups);

      for (const g of groups) {
        for (const t of groupTies(g.entryIds)) {
          await be.setDoc(`tournaments/${tournamentId}/ties/${t.id}`, {
            id: t.id, stage: 'group', groupId: g.id,
            entryA: t.entryA, entryB: t.entryB,
            lineupA: (byId[t.entryA] || {}).players || [],
            lineupB: (byId[t.entryB] || {}).players || [],
            firstStarter: 'A', legs: {},
          });
        }
      }
      await be.setDoc(`tournaments/${tournamentId}`, { numGroups, advancePerGroup, groups, status: 'groups' }, { merge: true });
      return groups;
    },

    /* ---- knockout stage ---- */
    /** Seeds the bracket from the given qualifier order (index 0 = seed 1), creates a tie
     *  document for every round-1 slot that isn't a bye, and moves to 'knockout' status. */
    async startKnockout(tournamentId, qualifierEntryIds) {
      const entries = await be.getCollection(`tournaments/${tournamentId}/entries`);
      const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
      const bracket = initBracket(qualifierEntryIds);
      await createReadyKnockoutTies(be, tournamentId, bracket, byId);
      await be.setDoc(`tournaments/${tournamentId}`, { bracket, status: 'knockout' }, { merge: true });
      return bracket;
    },

    /** Call once a knockout tie is finished (its winner is known) to advance the bracket,
     *  create the next round's tie document if it just became ready, and mark the
     *  tournament complete once the final has a winner. */
    async recordKnockoutResult(tournamentId, round, slot, winnerEntryId) {
      const t = await be.getDoc(`tournaments/${tournamentId}`);
      if (!t || !t.bracket) throw new Error('This tournament has no bracket yet.');
      const entries = await be.getCollection(`tournaments/${tournamentId}/entries`);
      const byId = Object.fromEntries(entries.map((e) => [e.id, e]));

      const bracket = advanceBracket(t.bracket, round, slot, winnerEntryId);
      await createReadyKnockoutTies(be, tournamentId, bracket, byId);

      const done = !!champion(bracket);
      await be.setDoc(`tournaments/${tournamentId}`, { bracket, status: done ? 'complete' : 'knockout' }, { merge: true });
      return bracket;
    },

    /* ---- scoring a tie (same turn-by-turn shape as a league match) ---- */
    setTieFields: (tournamentId, tieId, fields) => be.setDoc(tiePath(tournamentId, tieId), fields, { merge: true }),
    setTieLegStarter: (tournamentId, tieId, legNum, starter) =>
      be.updateDoc(tiePath(tournamentId, tieId), { [`legs.${legNum}.starter`]: starter }),
    writeTieTurns: (tournamentId, tieId, legNum, side, turns) =>
      be.updateDoc(tiePath(tournamentId, tieId), { [`legs.${legNum}.${side === 'A' ? 'a' : 'b'}`]: turns }),
    clearTie: (tournamentId, tieId) => be.setDoc(tiePath(tournamentId, tieId), { legs: {} }, { merge: true }),
  };
}

/** Creates a tie document for every knockout slot that has both entries filled but no tie yet. */
async function createReadyKnockoutTies(be, tournamentId, bracket, entriesById) {
  for (const round of bracket.rounds) {
    for (const tie of round.ties) {
      if (tie.bye || tie.tieId || !tie.entryA || !tie.entryB) continue;
      const tieId = `k${round.round}_${tie.slot}`;
      tie.tieId = tieId;
      await be.setDoc(`tournaments/${tournamentId}/ties/${tieId}`, {
        id: tieId, stage: 'knockout', round: round.round, slot: tie.slot,
        entryA: tie.entryA, entryB: tie.entryB,
        lineupA: (entriesById[tie.entryA] || {}).players || [],
        lineupB: (entriesById[tie.entryB] || {}).players || [],
        firstStarter: 'A', legs: {},
      });
    }
  }
}
