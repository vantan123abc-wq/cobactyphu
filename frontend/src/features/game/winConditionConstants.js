// Mirrors backend/src/stateMachine/gameEndMachine.js's own constant — no
// shared package between frontend/backend in this repo, same standing as
// every other mirrored backend constant this session. Only
// FINAL_PHASE_DURATION_ROUNDS is needed client-side (to compute "N rounds
// left") — FINAL_PHASE_TRIGGER_ROUND itself never needs mirroring, since
// the frontend never independently decides *whether* Final Phase started;
// it only ever watches gameState.finalPhaseStartedAtRound, which the
// server already computed.
export const FINAL_PHASE_DURATION_ROUNDS = 5

// Shared building supply totals — mirrors backend/src/domain/gameState.js's
// HOUSE_SUPPLY_TOTAL / HOTEL_SUPPLY_TOTAL (Phase 14, 2026-08-19). Needed only
// as the DENOMINATOR in MarketInfo's "n/32" readout; the live remaining counts
// are always the server's own gameState.houseSupply/hotelSupply, never
// recomputed here. Same mirroring standing as FINAL_PHASE_DURATION_ROUNDS
// above — no shared package exists between frontend and backend in this repo.
export const HOUSE_SUPPLY_TOTAL = 32
export const HOTEL_SUPPLY_TOTAL = 12
