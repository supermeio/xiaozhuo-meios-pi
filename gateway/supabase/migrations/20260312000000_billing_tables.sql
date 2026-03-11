-- Billing plans
CREATE TABLE IF NOT EXISTS plans (
  id            text PRIMARY KEY,
  name          text NOT NULL,
  price_cents   integer NOT NULL,
  budget_cents  integer NOT NULL,
  created_at    timestamptz DEFAULT now()
);

INSERT INTO plans (id, name, price_cents, budget_cents) VALUES
  ('free', 'Free', 0, 100),
  ('go', 'Go', 500, 500),
  ('plus', 'Plus', 1000, 1000),
  ('pro', 'Pro', 5000, 5000)
ON CONFLICT (id) DO NOTHING;

-- User plan assignments (one active per user per period)
CREATE TABLE IF NOT EXISTS user_plans (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  plan_id       text NOT NULL REFERENCES plans(id) DEFAULT 'free',
  period_start  timestamptz NOT NULL DEFAULT date_trunc('month', now()),
  period_end    timestamptz NOT NULL DEFAULT (date_trunc('month', now()) + interval '1 month'),
  created_at    timestamptz DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_plans_active ON user_plans(user_id, period_start);

ALTER TABLE user_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own plans" ON user_plans FOR SELECT USING (auth.uid() = user_id);

-- Per-call usage records
CREATE TABLE IF NOT EXISTS usage_records (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_id    uuid REFERENCES sandboxes(id) ON DELETE SET NULL,
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider      text NOT NULL DEFAULT 'anthropic',
  model         text NOT NULL,
  input_tokens  integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  cost_cents    numeric(10,4) NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_records_user_month ON usage_records(user_id, created_at);

ALTER TABLE usage_records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own usage" ON usage_records FOR SELECT USING (auth.uid() = user_id);

-- Monthly usage summary (fast budget check)
CREATE TABLE IF NOT EXISTS usage_monthly (
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  period          text NOT NULL,
  total_cost_cents numeric(10,4) NOT NULL DEFAULT 0,
  request_count   integer NOT NULL DEFAULT 0,
  updated_at      timestamptz DEFAULT now(),
  PRIMARY KEY (user_id, period)
);

ALTER TABLE usage_monthly ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Users can view own monthly usage" ON usage_monthly FOR SELECT USING (auth.uid() = user_id);

-- Budget check RPC: returns whether user has remaining budget
CREATE OR REPLACE FUNCTION check_budget(p_user_id uuid)
RETURNS jsonb
LANGUAGE plpgsql AS $$
DECLARE
  v_budget integer;
  v_used numeric(10,4);
  v_period text := to_char(now(), 'YYYY-MM');
BEGIN
  -- Get user's plan budget for current period
  SELECT p.budget_cents INTO v_budget
  FROM user_plans up
  JOIN plans p ON p.id = up.plan_id
  WHERE up.user_id = p_user_id
    AND now() >= up.period_start
    AND now() < up.period_end
  ORDER BY up.period_start DESC
  LIMIT 1;

  -- No plan = no budget
  IF v_budget IS NULL THEN
    RETURN jsonb_build_object('allowed', false, 'budget_cents', 0, 'used_cents', 0, 'reason', 'no_plan');
  END IF;

  -- Get current month usage
  SELECT COALESCE(total_cost_cents, 0) INTO v_used
  FROM usage_monthly
  WHERE user_id = p_user_id AND period = v_period;

  IF v_used IS NULL THEN v_used := 0; END IF;

  RETURN jsonb_build_object(
    'allowed', v_used < v_budget,
    'budget_cents', v_budget,
    'used_cents', v_used,
    'remaining_cents', GREATEST(v_budget - v_used, 0)
  );
END;
$$;

-- Record usage RPC: insert record + update monthly summary atomically
CREATE OR REPLACE FUNCTION record_usage(
  p_sandbox_id uuid,
  p_user_id uuid,
  p_provider text,
  p_model text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_cost_cents numeric
)
RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_period text := to_char(now(), 'YYYY-MM');
BEGIN
  INSERT INTO usage_records (sandbox_id, user_id, provider, model, input_tokens, output_tokens, cost_cents)
  VALUES (p_sandbox_id, p_user_id, p_provider, p_model, p_input_tokens, p_output_tokens, p_cost_cents);

  INSERT INTO usage_monthly (user_id, period, total_cost_cents, request_count)
  VALUES (p_user_id, v_period, p_cost_cents, 1)
  ON CONFLICT (user_id, period) DO UPDATE SET
    total_cost_cents = usage_monthly.total_cost_cents + p_cost_cents,
    request_count = usage_monthly.request_count + 1,
    updated_at = now();
END;
$$;
