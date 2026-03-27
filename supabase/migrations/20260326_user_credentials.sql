-- User credentials: per-user encrypted storage for external service credentials.
-- The gateway holds the encryption key; PG only stores ciphertext + IV.

CREATE TABLE IF NOT EXISTS user_credentials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  service TEXT NOT NULL,           -- e.g. 'google', 'aws', 'github'
  encrypted_data BYTEA NOT NULL,  -- AES-256-GCM ciphertext (includes auth tag)
  iv BYTEA NOT NULL,              -- 12-byte IV
  label TEXT DEFAULT '',          -- user-friendly name
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(user_id, service)
);

ALTER TABLE user_credentials ENABLE ROW LEVEL SECURITY;

-- No user-facing RLS policies: all access through gateway's service role
