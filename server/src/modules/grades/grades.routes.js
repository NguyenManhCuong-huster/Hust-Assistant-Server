import express from 'express';
import { requireAuth } from '../../shared/middleware/auth.middleware.js';
import { lwwCheck }    from '../../shared/middleware/lww.middleware.js';
import { validate }    from '../../shared/middleware/validate.middleware.js';
import { GradeSchema } from '../../dto/grades.dto.js';
import * as ctrl from './grades.controller.js';

const router = express.Router();
router.use(requireAuth);

router.get('/',       ctrl.listGrades);
router.post('/',      validate(GradeSchema), ctrl.createGrade);
router.put('/:id',    lwwCheck('grades'), validate(GradeSchema), ctrl.replaceGrade);
router.delete('/:id', lwwCheck('grades'), ctrl.deleteGrade);

export default router;
