// GET /api/v1/auth/me — API_CONTRACT.md, P03-T03. The longest-blocked item
// on this project's own "Blocked" list — needed a live `profiles` row to
// even test against, which was true when this task was first scoped
// (Phase 03) but stopped being true once real accounts started playing
// real games through this backend (this project's own many live-verification
// passes since). Rechecked the real blocker before writing anything, rather
// than trusting the stale note.
//
// `activeRoomId`/`activeGameId` are the actual reason this endpoint exists,
// not `req.user` alone — API_CONTRACT.md's own words: "lets a client that
// just reloaded the page decide 'show the lobby' vs 'show the board' vs
// 'show the home screen' in one call." Built alongside the frontend half
// that actually calls this on app boot (App.jsx) in the same pass — a
// backend-only version here would have repeated this project's own
// recurring "shipped but never wired in" pattern (calculateBuildHouse,
// TimerManager, eventCardDictionary.js, ...).
//
// Rate limiting (API_CONTRACT.md: "60/min per user") is deliberately not
// built — no rate-limiting middleware exists anywhere in this backend yet,
// and inventing one for a single endpoint would be new infrastructure this
// task was never asked to add. Flagged, not silently skipped.

import * as roomRepository from '../../infrastructure/repositories/roomRepository.js';
import * as gameRepository from '../../infrastructure/repositories/gameRepository.js';

export async function getMe(req, res, next) {
  try {
    const supabase = req.app.get('supabase');

    // A missing profiles row falls back to the raw auth id, same posture
    // roomRepository.js's own fetchPlayers() already established for the
    // identical scenario ("structurally correct, real content pending" —
    // not a silent swallow of a real error, and not a new, undocumented
    // error response either, since API_CONTRACT.md's own contract for this
    // endpoint only ever lists 401).
    const { data: profile } = await supabase.from('profiles').select('id, display_name, avatar_url').eq('id', req.user.id).single();

    // activeGameId is resolved *from* activeRoomId (games.room_id), not
    // independently — see gameRepository.js's findActiveGameIdForRoom for
    // why a playerId-keyed game_players query would always return null in
    // this backend's real, running system. No point even querying it when
    // there's no active room at all (a game can't outlive its own room).
    const activeRoomId = await roomRepository.findActiveRoomIdForPlayer(supabase, req.user.id);
    const activeGameId = activeRoomId ? await gameRepository.findActiveGameIdForRoom(supabase, activeRoomId) : null;

    return res.status(200).json({
      id: req.user.id,
      displayName: profile?.display_name ?? req.user.id,
      avatarUrl: profile?.avatar_url ?? null,
      activeRoomId,
      activeGameId,
    });
  } catch (err) {
    next(err);
  }
}
