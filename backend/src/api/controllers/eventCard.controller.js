// Event card dictionary read endpoint — 2026-08-21. Closes a real,
// previously-flagged gap: frontend/src/features/game/eventCardDictionary.js
// has been a hand-maintained mirror of domain/eventDictionary.js's
// EVENT_CARDS (used on explicit instruction, P11-T11, since no REST/socket
// path exposed this content at all) — that file's own header calls out the
// drift risk directly: "WILL SILENTLY DRIFT if the backend dictionary
// changes without a matching update here". Modeled on board.controller.js's
// own precedent exactly: static, in-memory reference content, same
// "Bearer JWT on every endpoint except /api/v1/health" rule (API_CONTRACT.md)
// applies — not left open just because there's no per-request computation.
//
// Unlike board_tiles (fetched from Supabase at boot, may be genuinely
// unavailable), EVENT_CARDS is a plain JS module constant — always present,
// no 503/"data not seeded yet" case exists for this endpoint.

import { EVENT_CARDS } from '../../domain/eventDictionary.js';

/**
 * GET /api/v1/event-cards
 */
export function getEventCards(req, res) {
  return res.status(200).json({ cards: EVENT_CARDS });
}
