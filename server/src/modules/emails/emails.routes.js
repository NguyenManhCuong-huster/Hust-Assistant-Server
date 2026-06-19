import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl       from './emails.controller.js';

const router = express.Router();

router.get('/',              requireAuth, ctrl.listEmails);
router.get('/all',           requireAuth, ctrl.listEmailsFlat);
router.get('/:id/thread',    requireAuth, ctrl.getEmailThread);
router.get('/:id/attachments', requireAuth, ctrl.getEmailAttachments);
router.get('/:id',           requireAuth, ctrl.getEmail);
router.patch('/:id/read',    requireAuth, ctrl.markAsRead);
router.delete('/:id',        requireAuth, ctrl.deleteEmail);
router.post('/sync',         requireAuth, ctrl.syncEmails);

export default router;
