import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl       from './sync.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',  ctrl.pullSync);
router.post('/', ctrl.pushSync);

export default router;
