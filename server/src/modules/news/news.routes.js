import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import * as ctrl       from './news.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',                          ctrl.listNews);
router.get('/recommendations',           ctrl.getRecommendations);
router.post('/recommendations/refresh',  ctrl.refreshRecommendations);
router.post('/recommendations/:id/dismiss', ctrl.dismissRecommendation);
router.post('/scrape',                   ctrl.scrapeNews);
router.get('/:id/attachments',           ctrl.getNewsAttachments);
router.get('/:id',                       ctrl.getNews);

export default router;
