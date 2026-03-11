-- Rate limiting table for Edge Function (stateless, needs DB-backed counters)
CREATE TABLE IF NOT EXISTS rate_limits (
  sandbox_id    uuid PRIMARY KEY REFERENCES sandboxes(id) ON DELETE CASCADE,
  minute_count  integer NOT NULL DEFAULT 0,
  minute_start  timestamptz NOT NULL DEFAULT now(),
  daily_count   integer NOT NULL DEFAULT 0,
  daily_start   timestamptz NOT NULL DEFAULT now()
);

-- Atomic rate limit check: increments counters and returns whether request is allowed
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_sandbox_id uuid,
  p_minute_limit integer DEFAULT 60,
  p_daily_limit integer DEFAULT 1000
) RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_now timestamptz := now();
  v_minute_count integer;
  v_daily_count integer;
BEGIN
  INSERT INTO rate_limits (sandbox_id, minute_count, minute_start, daily_count, daily_start)
  VALUES (p_sandbox_id, 1, date_trunc('minute', v_now), 1, date_trunc('day', v_now))
  ON CONFLICT (sandbox_id) DO UPDATE SET
    minute_count = CASE
      WHEN date_trunc('minute', v_now) > rate_limits.minute_start THEN 1
      ELSE rate_limits.minute_count + 1
    END,
    minute_start = CASE
      WHEN date_trunc('minute', v_now) > rate_limits.minute_start THEN date_trunc('minute', v_now)
      ELSE rate_limits.minute_start
    END,
    daily_count = CASE
      WHEN date_trunc('day', v_now) > rate_limits.daily_start THEN 1
      ELSE rate_limits.daily_count + 1
    END,
    daily_start = CASE
      WHEN date_trunc('day', v_now) > rate_limits.daily_start THEN date_trunc('day', v_now)
      ELSE rate_limits.daily_start
    END
  RETURNING minute_count, daily_count INTO v_minute_count, v_daily_count;

  RETURN jsonb_build_object(
    'allowed', v_minute_count <= p_minute_limit AND v_daily_count <= p_daily_limit,
    'minute_count', v_minute_count,
    'daily_count', v_daily_count
  );
END;
$$;

-- Token expiry column
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS token_expires_at timestamptz;

-- Hash existing plaintext tokens (SHA-256)
-- Tokens starting with 'sbx_' are plaintext and need hashing
UPDATE sandboxes
SET token = encode(sha256(convert_to(token, 'UTF8')), 'hex')
WHERE token IS NOT NULL AND token LIKE 'sbx_%';
