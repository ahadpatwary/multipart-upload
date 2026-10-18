v x-- Per-user storage accounting. All quota decisions are made with a single atomic UPDATE on this row.
CREATE TABLE IF NOT EXISTS user_storage (
  user_id        TEXT PRIMARY KEY,
  quota_bytes    BIGINT NOT NULL CHECK (quota_bytes >= 0),
  used_bytes     BIGINT NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes BIGINT NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0)
);

CREATE TABLE IF NOT EXISTS upload_sessions (
  id                  UUID PRIMARY KEY,
  user_id             TEXT        NOT NULL,
  object_key          TEXT        NOT NULL UNIQUE,
  s3_upload_id        TEXT,
  file_name           TEXT        NOT NULL,
  content_type        TEXT        NOT NULL,
  file_size           BIGINT      NOT NULL CHECK (file_size > 0),
  part_size           BIGINT      NOT NULL CHECK (part_size > 0),
  expected_part_count INTEGER     NOT NULL CHECK (expected_part_count BETWEEN 1 AND 10000),
  status              TEXT        NOT NULL CHECK (status IN
                        ('INITIATING','UPLOADING','COMPLETING','COMPLETED','ABORTING','ABORTED','FAILED','EXPIRED')),
  idempotency_key     TEXT        NOT NULL,
  reserved_bytes      BIGINT      NOT NULL CHECK (reserved_bytes >= 0),
  expires_at          TIMESTAMPTZ NOT NULL,
  completed_at        TIMESTAMPTZ,
  failure_reason      TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT upload_sessions_user_idem_uq UNIQUE (user_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS upload_sessions_user_active_idx
  ON upload_sessions (user_id) WHERE status IN ('INITIATING','UPLOADING','COMPLETING','ABORTING');

-- Worker sweep indexes
CREATE INDEX IF NOT EXISTS upload_sessions_expiry_idx
  ON upload_sessions (expires_at) WHERE status = 'UPLOADING';
CREATE INDEX IF NOT EXISTS upload_sessions_transient_idx
  ON upload_sessions (updated_at) WHERE status IN ('INITIATING','COMPLETING','ABORTING');
