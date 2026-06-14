import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { lwwCheck }    from '../../shared/middleware/lww.middleware.js';
import { validate }    from '../../shared/middleware/validate.middleware.js';
import { CreateTaskSchema, ReplaceTaskSchema, PatchTaskSchema } from '../../dto/tasks.dto.js';
import * as ctrl from './tasks.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',       ctrl.listTasks);
router.get('/:id',    ctrl.getTask);
router.post('/',      validate(CreateTaskSchema),  ctrl.createTask);
router.put('/:id',    lwwCheck('tasks'), validate(ReplaceTaskSchema), ctrl.replaceTask);
router.patch('/:id',  lwwCheck('tasks'), validate(PatchTaskSchema),   ctrl.patchTask);
router.delete('/:id', lwwCheck('tasks'), ctrl.deleteTask);

export default router;
