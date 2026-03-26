import { createClient, type SupabaseClient } from '@supabase/supabase-js'
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
  machine_secret: string | null
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

export async function getSandboxByMachineSecret(secret: string): Promise<Sandbox | null> {
  const { data, error } = await getSupabase()
    .from('sandboxes')
    .select('*')
    .eq('machine_secret', secret)
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

// ── Credential queries ──

export interface UserCredential {
  id: string
  user_id: string
  service: string
  encrypted_data: string   // base64-encoded ciphertext (Supabase returns bytea as base64)
  iv: string               // base64-encoded IV
  label: string
  created_at: string
  updated_at: string
}

export async function getCredential(userId: string, service: string): Promise<UserCredential | null> {
  const { data, error } = await getSupabase()
    .from('user_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('service', service)
    .single()

  if (error || !data) return null
  return data as UserCredential
}

export async function upsertCredential(
  userId: string,
  service: string,
  encryptedData: Buffer,
  iv: Buffer,
  label: string,
): Promise<UserCredential> {
  const { data, error } = await getSupabase()
    .from('user_credentials')
    .upsert(
      {
        user_id: userId,
        service,
        encrypted_data: encryptedData.toString('base64'),
        iv: iv.toString('base64'),
        label,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'user_id,service' }
    )
    .select('id, user_id, service, label, created_at, updated_at')
    .single()

  if (error) throw new Error(`Failed to upsert credential: ${error.message}`)
  return data as UserCredential
}

export async function deleteCredential(userId: string, service: string): Promise<boolean> {
  const { error, count } = await getSupabase()
    .from('user_credentials')
    .delete()
    .eq('user_id', userId)
    .eq('service', service)

  if (error) throw new Error(`Failed to delete credential: ${error.message}`)
  return (count ?? 0) > 0
}

export async function listCredentials(userId: string): Promise<Pick<UserCredential, 'service' | 'label' | 'created_at' | 'updated_at'>[]> {
  const { data, error } = await getSupabase()
    .from('user_credentials')
    .select('service, label, created_at, updated_at')
    .eq('user_id', userId)
    .order('service')

  if (error) throw new Error(`Failed to list credentials: ${error.message}`)
  return data ?? []
}

// ── Signed URL queries ──

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
