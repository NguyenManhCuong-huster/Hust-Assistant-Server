-- Migration: bỏ unique index natural-key của grades.
-- Chạy 1 lần trên DB đang có data. Idempotent (IF EXISTS).
--
-- Lý do: 1 kỳ ĐƯỢC PHÉP trùng (semester, course_code) (học lại trong kỳ). Chống nhân bản
-- chuyển sang idempotency key = chính `id` (PK) + ON CONFLICT (id) ở insertGrade. Index cũ
-- (cấm trùng kỳ+mã) cản việc tạo bản trùng cố ý → phải gỡ.
DROP INDEX IF EXISTS uq_grades_user_sem_course_active;
