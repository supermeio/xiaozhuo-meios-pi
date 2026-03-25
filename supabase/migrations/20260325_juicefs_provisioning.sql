-- Per-user JuiceFS provisioning: PG role + schema + RLS
-- Each sandbox user gets an isolated PG role that can only access their own JuiceFS metadata schema.

-- 1. Create the provisioning function
CREATE OR REPLACE FUNCTION provision_juicefs_role(
  role_name text,
  role_password text,
  schema_name text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Create role if not exists
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
    EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L', role_name, role_password);
  ELSE
    EXECUTE format('ALTER ROLE %I PASSWORD %L', role_name, role_password);
  END IF;

  -- Grant the new role to postgres so we can set ownership
  EXECUTE format('GRANT %I TO postgres', role_name);

  -- Create schema owned by the role
  EXECUTE format('CREATE SCHEMA IF NOT EXISTS %I AUTHORIZATION %I', schema_name, role_name);
  EXECUTE format('ALTER SCHEMA %I OWNER TO %I', schema_name, role_name);

  -- Grant full access to own schema
  EXECUTE format('GRANT ALL ON SCHEMA %I TO %I', schema_name, role_name);
  EXECUTE format('GRANT ALL ON ALL TABLES IN SCHEMA %I TO %I', schema_name, role_name);
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA %I GRANT ALL ON TABLES TO %I', schema_name, role_name);

  -- Revoke ALL access to public schema (sandboxes, juicefs_credentials, etc.)
  EXECUTE format('REVOKE ALL ON SCHEMA public FROM %I', role_name);
  EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA public FROM %I', role_name);
  EXECUTE format('REVOKE CREATE ON SCHEMA public FROM %I', role_name);

  -- Revoke default privileges so future tables in public are also inaccessible
  EXECUTE format('ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM %I', role_name);
END;
$$;

-- 2. Create juicefs_credentials table (idempotent)
CREATE TABLE IF NOT EXISTS juicefs_credentials (
  user_id TEXT PRIMARY KEY,
  pg_schema TEXT NOT NULL,
  pg_role TEXT,
  pg_password TEXT,
  s3_access_key_id TEXT NOT NULL,
  s3_secret_access_key TEXT NOT NULL,
  s3_bucket TEXT NOT NULL DEFAULT 'meios-juicefs',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Enable RLS on juicefs_credentials — deny all access except service role
ALTER TABLE juicefs_credentials ENABLE ROW LEVEL SECURITY;

-- No RLS policies = deny all for anon/authenticated roles.
-- Only service_role (used by gateway) bypasses RLS.
-- Drop any existing permissive policies just in case.
DROP POLICY IF EXISTS "deny_all" ON juicefs_credentials;

COMMENT ON TABLE juicefs_credentials IS 'Per-user JuiceFS credentials. RLS enabled, no policies = deny all except service_role.';
