import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

const migrationUrl = new URL(
  '../../supabase/migrations/20260722030527_close_public_data_api_exposure.sql',
  import.meta.url,
)

describe('Supabase public Data API hardening migration', () => {
  it('closes current and future unprotected relations', async () => {
    const sql = await readFile(migrationUrl, 'utf8')

    expect(sql).toMatch(/and not c\.relrowsecurity/i)
    expect(sql).toMatch(/alter table %I\.%I enable row level security/i)
    expect(sql).toMatch(
      /revoke all privileges on table %I\.%I from anon, authenticated/i,
    )
    expect(sql).toMatch(
      /alter default privileges for role postgres in schema public[\s\S]+revoke all privileges on tables from anon, authenticated/i,
    )
    expect(sql).toMatch(/alter view %I\.%I set \(security_invoker = true\)/i)
    expect(sql).toMatch(
      /revoke execute on function public\.provision_juicefs_role\(text, text, text\)[\s\S]+from public, anon, authenticated/i,
    )
    expect(sql).toMatch(
      /grant execute on function public\.provision_juicefs_role\(text, text, text\)[\s\S]+to service_role/i,
    )
  })
})
