CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

CREATE TYPE provider_type    AS ENUM ('GMAIL', 'OUTLOOK', 'CTT');
CREATE TYPE task_category    AS ENUM ('TODO', 'CLASS', 'EXAM');
CREATE TYPE source_origin    AS ENUM ('MANUAL', 'EMAIL', 'NEWS', 'CTT');
CREATE TYPE account_status   AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');
CREATE TYPE attachment_owner AS ENUM ('NEWS', 'EMAIL');

-- ═════════════════════════════════════════════════════════════ USERS
CREATE TABLE "users" (
  id            UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  email         VARCHAR(255) UNIQUE NOT NULL,
  password_hash TEXT,
  created_at    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
  is_deleted    BOOLEAN      DEFAULT FALSE
);

CREATE TABLE "user_info" (
  user_id       UUID         PRIMARY KEY REFERENCES "users"(id) ON DELETE CASCADE,
  student_id    VARCHAR(20),
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
CREATE INDEX idx_user_info_student_id ON "user_info"(student_id);

-- ═════════════════════════════════════════════════════════════ ACCOUNTS
CREATE TABLE "accounts" (
  id                UUID           PRIMARY KEY DEFAULT uuid_generate_v4(),
  provider          provider_type  NOT NULL,
  username_or_email VARCHAR(255)   NOT NULL,
  access_token      TEXT           NOT NULL,
  status            account_status DEFAULT 'ACTIVE',
  created_at        TIMESTAMPTZ    DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT uq_accounts_provider_email UNIQUE (provider, username_or_email)
);

CREATE TABLE "user_account_cross_ref" (
  user_id    UUID REFERENCES "users"(id)    ON DELETE CASCADE,
  account_id UUID REFERENCES "accounts"(id) ON DELETE CASCADE,
  linked_at  TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, account_id)
);
CREATE INDEX idx_uac_account_id ON "user_account_cross_ref"(account_id);

-- ═════════════════════════════════════════════════════════════ NEWS
CREATE TABLE "news_sources" (
  id          UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  name        VARCHAR(255) NOT NULL,
  description TEXT,
  home_url    TEXT,
  mod_time    TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
  is_deleted  BOOLEAN      DEFAULT FALSE,
  CONSTRAINT uq_news_sources_name UNIQUE (name)
);

CREATE TABLE "news" (
  id           UUID        PRIMARY KEY DEFAULT uuid_generate_v4(),
  source_id    UUID        REFERENCES "news_sources"(id) ON DELETE SET NULL,
  -- 'NEWS' = TIN TỨC, 'PLAN' = KẾ HOẠCH
  kind         VARCHAR(10) NOT NULL DEFAULT 'NEWS' CHECK (kind IN ('NEWS', 'PLAN')),
  title        TEXT        NOT NULL,
  summary      TEXT,                              -- plain text full body của trang chi tiết
  article_url  TEXT,
  image_url    TEXT,                              -- thumbnail (chỉ NEWS có; PLAN null)
  tag          VARCHAR(20),                       -- 'CTSV' | 'ĐTĐH' | 'ĐTSĐH' | 'VLVH' | 'VĐTLT' | 'DTDH' ...
  published_at TIMESTAMPTZ,
  mod_time     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  is_deleted   BOOLEAN     DEFAULT FALSE,
  CONSTRAINT uq_news_article_url UNIQUE (article_url)
);
CREATE INDEX idx_news_source_id    ON "news"(source_id);
CREATE INDEX idx_news_kind         ON "news"(kind);
CREATE INDEX idx_news_published_at ON "news"(published_at DESC);
CREATE INDEX idx_news_tag          ON "news"(tag);

-- Seed nguồn HUST CTT
INSERT INTO "news_sources" (name, description, home_url)
VALUES (
  'HUST CTT',
  'Cổng thông tin sinh viên - Đại học Bách Khoa Hà Nội',
  'https://ctt.hust.edu.vn/'
)
ON CONFLICT (name) DO NOTHING;

-- ═════════════════════════════════════════════════════════════ NEWS RECOMMENDATIONS
-- Cache kết quả đề xuất news cho từng user, recompute lazy (TTL 6h).
-- Invalidate (xoá rows) khi user update user_info → next request sẽ recompute.
CREATE TABLE "news_recommendations" (
  user_id          UUID         NOT NULL REFERENCES "users"(id) ON DELETE CASCADE,
  news_id          UUID         NOT NULL REFERENCES "news"(id)  ON DELETE CASCADE,
  score            REAL         NOT NULL,
  reason           TEXT,                                  -- "Khớp: K66, Công nghệ thông tin"
  matched_keywords TEXT[]       NOT NULL DEFAULT '{}',    -- ['K66','CNTT']
  generated_at     TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
  is_dismissed     BOOLEAN      NOT NULL DEFAULT FALSE,
  PRIMARY KEY (user_id, news_id)
);
CREATE INDEX idx_news_rec_user_score ON "news_recommendations"(user_id, score DESC);
CREATE INDEX idx_news_rec_user_genat ON "news_recommendations"(user_id, generated_at DESC);

-- ═════════════════════════════════════════════════════════════ EMAILS
CREATE TABLE "emails" (
  id               UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id       UUID         REFERENCES "accounts"(id) ON DELETE CASCADE,
  gmail_message_id VARCHAR(32)  NOT NULL,
  gmail_thread_id  VARCHAR(32),
  sender           VARCHAR(255),
  recipient        TEXT,
  subject          TEXT,
  snippet          TEXT,
  body_text        TEXT,
  body_html        TEXT,
  deep_link_intent TEXT,
  received_at      TIMESTAMPTZ,
  mod_time         TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
  is_deleted       BOOLEAN      DEFAULT FALSE,
  CONSTRAINT uq_emails_account_msg UNIQUE (account_id, gmail_message_id)
);

CREATE INDEX idx_emails_account_id  ON "emails"(account_id);
CREATE INDEX idx_emails_received_at ON "emails"(received_at DESC);
CREATE INDEX idx_emails_thread_time ON "emails"(gmail_thread_id, received_at);

CREATE TABLE "attachments" (
  id                  UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  owner_type          attachment_owner NOT NULL,
  owner_id            UUID             NOT NULL,
  file_name           TEXT             NOT NULL,
  mime_type           VARCHAR(127),
  size_bytes          BIGINT,
  storage_path        TEXT,
  source_url          TEXT,
  gmail_attachment_id TEXT,
  is_inline           BOOLEAN          DEFAULT FALSE,
  created_at          TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
  mod_time            TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
  is_deleted          BOOLEAN          DEFAULT FALSE,

  CONSTRAINT uq_attachments_owner_filename UNIQUE (owner_type, owner_id, file_name)
);

CREATE INDEX idx_attachments_owner   ON "attachments"(owner_type, owner_id);
CREATE INDEX idx_attachments_modtime ON "attachments"(mod_time);

-- Cascade soft-delete: khi 1 email/news bị soft-delete → attachments của nó
-- cũng soft-delete theo. Không xoá file đĩa (cleanup job riêng).
CREATE OR REPLACE FUNCTION fn_cascade_delete_attachments() RETURNS TRIGGER AS $$
BEGIN
  IF TG_TABLE_NAME = 'emails' THEN
    UPDATE attachments
       SET is_deleted = TRUE, mod_time = CURRENT_TIMESTAMP
     WHERE owner_type = 'EMAIL' AND owner_id = NEW.id AND NEW.is_deleted = TRUE;
  ELSIF TG_TABLE_NAME = 'news' THEN
    UPDATE attachments
       SET is_deleted = TRUE, mod_time = CURRENT_TIMESTAMP
     WHERE owner_type = 'NEWS' AND owner_id = NEW.id AND NEW.is_deleted = TRUE;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_emails_soft_delete_attachments
AFTER UPDATE OF is_deleted ON emails
FOR EACH ROW WHEN (NEW.is_deleted = TRUE AND OLD.is_deleted = FALSE)
EXECUTE FUNCTION fn_cascade_delete_attachments();

CREATE TRIGGER trg_news_soft_delete_attachments
AFTER UPDATE OF is_deleted ON news
FOR EACH ROW WHEN (NEW.is_deleted = TRUE AND OLD.is_deleted = FALSE)
EXECUTE FUNCTION fn_cascade_delete_attachments();

-- ═════════════════════════════════════════════════════════════ TASKS & TAGS
CREATE TABLE "tasks" (
  id           UUID             PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id      UUID             REFERENCES "users"(id) ON DELETE CASCADE,
  title        TEXT             NOT NULL,
  description  TEXT,
  start_time   TIMESTAMPTZ,
  end_time     TIMESTAMPTZ,
  task_type    task_category    DEFAULT 'TODO',
  is_completed BOOLEAN          DEFAULT FALSE,
  source_type  source_origin    DEFAULT 'MANUAL',
  source_id    UUID,
  priority     SMALLINT         NOT NULL DEFAULT 2 CHECK (priority BETWEEN 1 AND 4),
  latitude     DOUBLE PRECISION CHECK (latitude  IS NULL OR latitude  BETWEEN -90  AND 90),
  longitude    DOUBLE PRECISION CHECK (longitude IS NULL OR longitude BETWEEN -180 AND 180),
  address_name TEXT,
  mod_time     TIMESTAMPTZ      DEFAULT CURRENT_TIMESTAMP,
  is_deleted   BOOLEAN          DEFAULT FALSE
);
CREATE INDEX idx_tasks_user_id   ON "tasks"(user_id);
CREATE INDEX idx_tasks_source    ON "tasks"(source_type, source_id);
CREATE INDEX idx_tasks_mod_time  ON "tasks"(mod_time);

CREATE TABLE "tags" (
  id         UUID         PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id    UUID         REFERENCES "users"(id) ON DELETE CASCADE,
  name       VARCHAR(100) NOT NULL,
  color_hex  VARCHAR(7),
  mod_time   TIMESTAMPTZ  DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN      DEFAULT FALSE,
  CONSTRAINT uq_tags_user_name UNIQUE (user_id, name)
);
CREATE INDEX idx_tags_user_id  ON "tags"(user_id);
CREATE INDEX idx_tags_mod_time ON "tags"(mod_time);

CREATE TABLE "task_tag_cross_ref" (
  task_id    UUID REFERENCES "tasks"(id) ON DELETE CASCADE,
  tag_id     UUID REFERENCES "tags"(id)  ON DELETE CASCADE,
  mod_time   TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  is_deleted BOOLEAN     DEFAULT FALSE,
  PRIMARY KEY (task_id, tag_id)
);
CREATE INDEX idx_ttcr_tag_id ON "task_tag_cross_ref"(tag_id);
