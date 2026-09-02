// Auth routes — P03-T03. Mounted under /api/v1/auth behind
// auth/authMiddleware.js in app.js, same as every other real route.

import { Router } from 'express';
import { getMe } from '../controllers/auth.controller.js';

const router = Router();

router.get('/me', getMe);

export default router;
