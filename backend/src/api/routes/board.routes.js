// Static board layout routes — P11-T03. Mounted under /api/v1/boards
// behind auth/authMiddleware.js in app.js, same as room.routes.js.

import { Router } from 'express';
import { getBoardConfig } from '../controllers/board.controller.js';

const router = Router();

router.get('/:boardId', getBoardConfig);

export default router;
