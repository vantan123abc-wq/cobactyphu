// Event card dictionary routes — 2026-08-21. Mounted under
// /api/v1/event-cards behind auth/authMiddleware.js in app.js, same as
// board.routes.js/room.routes.js.

import { Router } from 'express';
import { getEventCards } from '../controllers/eventCard.controller.js';

const router = Router();

router.get('/', getEventCards);

export default router;
