-- Add per-sandbox token for LLM proxy authentication.
-- Sandboxes use this token (as x-api-key) to call the gateway's
-- Anthropic API proxy, so the real ANTHROPIC_API_KEY never enters any sandbox.
ALTER TABLE sandboxes ADD COLUMN IF NOT EXISTS token text;
