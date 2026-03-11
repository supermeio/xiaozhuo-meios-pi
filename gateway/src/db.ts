import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { createHash } from 'node:crypto'
import { config } from './config.js'

// ── Types ──

export interface Sandbox {
  id: string
  user_id: string
  daytona_id: string
  signed_url: string | null
  signed_url_exp: string | null
  port: number
  token: string | null
  status: 'active' | 'suspended' | 'error'
  token_expires_at: string | null
  created_at: string
  updated_at: string
}

// ── Supabase client ──

let _supabase: SupabaseClient | null = null

export function getSupabase(): SupabaseClient {
  if (!_supabase) {
    _supabase = createClient(config.supabase.url, config.supabase.secretKey, {
      auth: { persistSession: false },
    })
  }
  return _supabase
}

// ── Sandbox queries ──

export async function getSandboxByUserId(userId: string): Promise<Sandbox | null> {
  const { data, error } = await getSupabase()
    .from('sandboxes')
    .select('*')
    .eq('user_id', userId)
    .eq('status', 'active')
    .single()

  if (error || !data) return null
  return data as Sandbox
}

export async function upsertSandbox(sandbox: Partial<Sandbox> & { user_id: string }): Promise<Sandbox> {
  const { data, error } = await getSupabase()
    .from('sandboxes')
    .upsert(
      { ...sandbox, updated_at: new Date().toISOString() },
      { onConflict: 'user_id' }
    )
    .select()
    .single()

  if (error) throw new Error(`Failed to upsert sandbox: ${error.message}`)
  return data as Sandbox
}

export async function getSandboxByToken(token: string): Promise<Sandbox | null> {
  const hashedToken = createHash('sha256').update(token).digest('hex')
  const { data, error } = await getSupabase()
    .from('sandboxes')
    .select('*')
    .eq('token', hashedToken)
    .eq('status', 'active')
    .or(`token_expires_at.gt.${new Date().toISOString()},token_expires_at.is.null`)
    .single()

  if (error || !data) return null
  return data as Sandbox
}

export async function updateSignedUrl(
  userId: string,
  signedUrl: string,
  expiresAt: string
): Promise<void> {
  const { error } = await getSupabase()
    .from('sandboxes')
    .update({
      signed_url: signedUrl,
      signed_url_exp: expiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', userId)

  if (error) throw new Error(`Failed to update signed URL: ${error.message}`)
}
