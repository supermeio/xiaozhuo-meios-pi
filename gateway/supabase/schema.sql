-- meios auth gateway — Supabase schema
-- Run this in the Supabase SQL Editor after creating your project.

-- Sandboxes: maps users to their Daytona sandbox
CREATE TABLE sandboxes (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  daytona_id      text NOT NULL,
  signed_url      text,
  signed_url_exp  timestamptz,
  port            integer DEFAULT 18800,
  status          text DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'error')),
  created_at      timestamptz DEFAULT now(),
  updated_at      timestamptz DEFAULT now()
);

-- One active sandbox per user
CREATE UNIQUE INDEX idx_sandboxes_user ON sandboxes(user_id) WHERE status = 'active';

-- Row Level Security: users can only see their own sandbox
ALTER TABLE sandboxes ENABLE ROW LEVEL SECURITY;

-- The auth gateway uses the service_role key, so RLS doesn't apply to it.
-- But if we ever query from the client side, this protects the data.
CREATE POLICY "Users can view own sandbox"
  ON sandboxes FOR SELECT
  USING (auth.uid() = user_id);

-- Future: tenants table
-- CREATE TABLE tenants (
--   id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
--   name       text NOT NULL,
--   created_at timestamptz DEFAULT now()
-- );
-- CREATE TABLE tenant_members (
--   tenant_id uuid REFERENCES tenants(id) ON DELETE CASCADE,
--   user_id   uuid REFERENCES auth.users(id) ON DELETE CASCADE,
--   role      text DEFAULT 'member',
--   PRIMARY KEY (tenant_id, user_id)
-- );
