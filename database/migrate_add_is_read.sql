-- Migration: thêm cột is_read vào bảng emails
-- Chạy 1 lần trên DB đang có data. Idempotent (IF NOT EXISTS).

ALTER TABLE emails
  ADD COLUMN IF NOT EXISTS is_read BOOLEAN NOT NULL DEFAULT FALSE;
