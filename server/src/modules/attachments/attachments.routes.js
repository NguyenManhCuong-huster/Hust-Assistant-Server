import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl       from './attachments.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/:id/meta',     ctrl.getMeta);
router.get('/:id/download', ctrl.download);
router.get('/by-owner',     ctrl.listByOwner);

export default router;
