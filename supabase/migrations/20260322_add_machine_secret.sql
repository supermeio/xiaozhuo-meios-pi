-- Add per-machine secret column for sandbox auth isolation
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS machine_secret TEXT;
