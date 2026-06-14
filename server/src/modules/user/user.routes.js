import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { validate }    from '../../shared/middleware/validate.middleware.js';
import { CreateUserInfoSchema, UpsertUserInfoSchema, PatchUserInfoSchema } from '../../dto/user.dto.js';
import * as ctrl from './user.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',    ctrl.getInfo);
router.post('/',   validate(CreateUserInfoSchema),  ctrl.createInfo);
router.put('/',    validate(UpsertUserInfoSchema),   ctrl.upsertInfo);
router.patch('/',  validate(PatchUserInfoSchema),    ctrl.patchInfo);
router.delete('/', ctrl.deleteInfo);

export default router;
