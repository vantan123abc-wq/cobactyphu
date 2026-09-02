// Room lobby routes — API_CONTRACT.md's Rooms section (create/join/get/
// ready/start; leave is a separate future task). Mounted under
// /api/v1/rooms behind auth/authMiddleware.js in app.js — every handler
// here assumes req.user is already set.
//
// ready/start use :id (the room's internal id), not :joinCode — joinCode
// is only ever used to *find* a room to join in the first place; every
// action after that operates on the id, same as :id already does for GET.

import { Router } from 'express';
import { createRoom, joinRoom, getRoom, setReady, setZodiac, startGame, leaveRoom, kickPlayer } from '../controllers/room.controller.js';

const router = Router();

router.post('/', createRoom);
router.post('/:code/join', joinRoom);
router.get('/:id', getRoom);
router.patch('/:id/ready', setReady);
router.patch('/:id/zodiac', setZodiac);
router.post('/:id/start', startGame);
router.post('/:id/leave', leaveRoom);
router.post('/:id/kick', kickPlayer);

export default router;
