import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { lwwCheck }    from '../../shared/middleware/lww.middleware.js';
import { validate }    from '../../shared/middleware/validate.middleware.js';
import { CreateTagSchema, UpdateTagSchema } from '../../dto/tags.dto.js';
import * as ctrl from './tags.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',       ctrl.listTags);
router.post('/',      validate(CreateTagSchema), ctrl.createTag);
router.put('/:id',    lwwCheck('tags'), validate(UpdateTagSchema), ctrl.updateTag);
router.delete('/:id', lwwCheck('tags'), ctrl.deleteTag);

export default router;
