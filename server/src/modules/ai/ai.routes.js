import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl from './ai.controller.js';

const router = express.Router();
router.use(requireAuth);

router.post('/upload-attachment', ctrl.uploadMiddleware, ctrl.uploadAttachment);
router.post('/chat',              ctrl.standaloneChat);
router.post('/email-chat',        ctrl.emailChat);
router.post('/news-chat',         ctrl.newsChat);

// Streaming (SSE) — đẩy text deltas về client ngay khi model sinh ra.
router.post('/chat/stream',       ctrl.standaloneChatStream);
router.post('/email-chat/stream', ctrl.emailChatStream);
router.post('/news-chat/stream',  ctrl.newsChatStream);

export default router;
