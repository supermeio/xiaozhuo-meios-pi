-- API keys for developer/agent access (alternative to JWT)
CREATE TABLE IF NOT EXISTS api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  key_hash    text NOT NULL UNIQUE,        -- SHA-256 hash of the key (never store plaintext)
  key_prefix  text NOT NULL,               -- first 8 chars for identification (meios_xxxxxxxx)
  name        text NOT NULL DEFAULT 'default',
  scopes      text[] NOT NULL DEFAULT '{}', -- empty = full access
  last_used   timestamptz,
  expires_at  timestamptz,                 -- null = never expires
  created_at  timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);

ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own API keys" ON api_keys FOR SELECT USING (auth.uid() = user_id);
