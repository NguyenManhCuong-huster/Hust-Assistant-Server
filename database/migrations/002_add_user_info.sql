-- Migration: 002_add_user_info.sql
-- Thêm bảng user_info vào DB đã tồn tại (không làm mất dữ liệu cũ).
-- Chạy: psql -U admin -d notification_aggregator -f database/migrations/002_add_user_info.sql

BEGIN;

CREATE TABLE IF NOT EXISTS "user_info" (
  user_id       UUID         PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
  mssv          VARCHAR(20)  UNIQUE,
  full_name     VARCHAR(255),
  date_of_birth DATE,
  phone         VARCHAR(20),
  school        VARCHAR(255),
  major         VARCHAR(255),
  class_name    VARCHAR(50),
  course        VARCHAR(10),
  created_at    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
  mod_time      TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_user_info_mssv ON "user_info"(mssv);

COMMIT;
