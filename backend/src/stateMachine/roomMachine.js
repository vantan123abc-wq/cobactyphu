// Room state machine — GAME_STATE_MACHINE.md §1/§8, the pre-game portion
// (WAITING_FOR_PLAYERS through STARTING/IN_PROGRESS, plus the ABANDONED
// terminal branch). Pure function: no I/O, no database driver, no
// Express, no Socket.IO.
//
// Scope boundary: transitionRoom only ever changes Room.status — it has
// no opinion on room_players (join/leave/kick/ready-toggle), a different
// table/domain this Room shape doesn't model. "All players ready" / "a
// player un-readied" arrive here as already-decided events
// (ALL_PLAYERS_READY / PLAYER_UNREADY); computing *whether* everyone is
// ready is the caller's job, not this state machine's.
//
// updatedAt is deliberately left untouched by transitionRoom — same
// reasoning as applyTransaction.js not fabricating id/createdAt: the real
// rooms.updated_at is DB-trigger-maintained, not application-computed.
//
// No import from domain/room.js: TRANSITIONS' keys already are the 5 real
// rooms.status values (ROOM_STATUSES), kept in sync by hand rather than by
// reference, since importing just to name the object's own keys added
// nothing at runtime.

export class InvalidRoomTransitionError extends Error {
  constructor(currentStatus, eventType) {
    super(`transitionRoom: no transition from '${currentStatus}' on event '${eventType}'`);
    this.name = 'InvalidRoomTransitionError';
    this.currentStatus = currentStatus;
    this.eventType = eventType;
  }
}

// GAME_STATE_MACHINE.md §1's mermaid, restricted to what Room.status alone
// governs:
//   WAITING_FOR_PLAYERS --> READY_CHECK: all non-host ready
//   READY_CHECK --> WAITING_FOR_PLAYERS: a player un-readies
//   READY_CHECK --> STARTING: host starts
//   STARTING --> IN_PROGRESS: board selected, engine initialized
//   WAITING_FOR_PLAYERS --> ABANDONED: host leaves / idle timeout
// in_progress and abandoned are terminal from this machine's point of view
// (in_progress hands off to turnMachine.js's turn sub-machine; abandoned
// has no further outbound transition in GAME_STATE_MACHINE.md §1).
const TRANSITIONS = Object.freeze({
  waiting_for_players: Object.freeze({
    ALL_PLAYERS_READY: 'ready_check',
    HOST_LEFT: 'abandoned',
    IDLE_TIMEOUT: 'abandoned',
  }),
  ready_check: Object.freeze({
    PLAYER_UNREADY: 'waiting_for_players',
    HOST_START: 'starting',
  }),
  starting: Object.freeze({
    ENGINE_INITIALIZED: 'in_progress',
  }),
  in_progress: Object.freeze({}),
  abandoned: Object.freeze({}),
});

/**
 * @param {import('../domain/room.js').Room} room
 * @param {{ type: string }} event
 * @returns {import('../domain/room.js').Room} a new Room with the updated status; every other field, including updatedAt, is carried over unchanged
 * @throws {InvalidRoomTransitionError} if `event.type` has no defined transition from `room.status`
 */
export function transitionRoom(room, event) {
  const nextStatus = TRANSITIONS[room.status]?.[event.type];

  if (!nextStatus) {
    throw new InvalidRoomTransitionError(room.status, event.type);
  }

  return { ...room, status: nextStatus };
}
