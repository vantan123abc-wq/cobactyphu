// Room — mirrors `rooms` (backend/supabase/migrations/0001_core_tables.sql),
// GAME_STATE_MACHINE.md §1's pre-game portion of the Game Lifecycle. Pure
// data shape: no I/O, no database driver, no framework import.
//
// ROOM_CREATED (GAME_STATE_MACHINE.md §1: "Host created the room;
// instantaneous, no other players yet") is a transient pseudo-state, not a
// value rooms.status can ever literally hold — the DB column's own default
// is 'waiting_for_players', so a real Room row never exists with status
// 'room_created'. createRoom() below realizes that transition implicitly
// (it always constructs a Room already at waiting_for_players) instead of
// exposing ROOM_CREATED as a real status value.
//
// ROOM_STATUSES intentionally matches rooms.status's CHECK constraint
// exactly — 5 values, including 'in_progress' — not the 5-value sketch
// (ROOM_CREATED..STARTING/ABANDONED, no IN_PROGRESS) this task was
// originally scoped with, which would have silently dropped a real,
// already-approved DB value. Flagged explicitly rather than chosen
// silently — see the Required Final Report.

export const ROOM_STATUSES = Object.freeze([
  'waiting_for_players',
  'ready_check',
  'starting',
  'in_progress',
  'abandoned',
]);

/**
 * @typedef {Object} Room
 * @property {string} id - uuid, rooms.id
 * @property {string} joinCode - 6 chars, rooms.join_code
 * @property {string} hostId - FK profiles.id, rooms.host_id
 * @property {(typeof ROOM_STATUSES[number])} status
 * @property {string} createdAt - ISO timestamp
 * @property {string} updatedAt - ISO timestamp; DB-trigger-maintained on
 *   the real table ("bumped by trigger on update") — never fabricated by
 *   application code here, same reasoning as applyTransaction.js not
 *   fabricating id/createdAt
 * @property {string} ruleset - 'CLASSIC' or 'ASYMMETRIC'
 */

/**
 * Realizes GAME_STATE_MACHINE.md §1's ROOM_CREATED -> WAITING_FOR_PLAYERS
 * transition: a Room always comes into existence already at
 * 'waiting_for_players', matching rooms.status's own DB default.
 * @param {Object} fields
 * @param {string} fields.id
 * @param {string} fields.joinCode
 * @param {string} fields.hostId
 * @param {string} fields.createdAt
 * @param {string} [fields.updatedAt] - defaults to createdAt, matching the DB's own default-on-insert behavior
 * @param {string} [fields.ruleset] - 'CLASSIC' or 'ASYMMETRIC'
 * @returns {Room}
 */
export function createRoom(fields) {
  if (typeof fields.joinCode !== 'string' || fields.joinCode.length !== 6) {
    throw new TypeError(`createRoom: joinCode must be exactly 6 characters (got '${fields.joinCode}')`);
  }

  return {
    id: fields.id,
    joinCode: fields.joinCode,
    hostId: fields.hostId,
    status: 'waiting_for_players',
    ruleset: fields.ruleset === 'ASYMMETRIC' ? 'ASYMMETRIC' : 'CLASSIC',
    createdAt: fields.createdAt,
    updatedAt: fields.updatedAt ?? fields.createdAt,
  };
}
