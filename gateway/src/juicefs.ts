/**
 * Per-user JuiceFS provisioning: PG role + schema + S3 IAM credentials.
 *
 * Each user gets:
 * - A PostgreSQL role with LOGIN, scoped to their own schema only
 * - A PostgreSQL schema (juicefs_{userId}) for JuiceFS metadata
 * - An S3 IAM user with credentials scoped to their prefix in the shared bucket
 *
 * Security: sandbox receives per-user PG credentials (not master password).
 * Even if leaked, attacker can only access that user's JuiceFS metadata.
 *
 * `juicefs format` runs in the sandbox entrypoint (first mount auto-formats).
 * This module only prepares the infrastructure (role + schema + IAM).
 */

import { randomBytes } from 'node:crypto'
import {
  IAMClient,
  CreateUserCommand,
  PutUserPolicyCommand,
  CreateAccessKeyCommand,
  ListAccessKeysCommand,
  DeleteAccessKeyCommand,
} from '@aws-sdk/client-iam'
import { config } from './config.js'
import { getSupabase } from './db.js'
import { log } from './log.js'

function slog(msg: string, data?: Record<string, unknown>) { log('juicefs', msg, data) }

const iam = new IAMClient({
  region: config.juicefs.s3Region,
  credentials: {
    accessKeyId: config.juicefs.awsAccessKeyId,
    secretAccessKey: config.juicefs.awsSecretAccessKey,
  },
})

export interface JuiceFSCredentials {
  metaUrl: string       // postgres://juicefs_user_{id}:{password}@...?search_path=juicefs_{id}
  s3AccessKey: string   // per-user IAM access key
  s3SecretKey: string   // per-user IAM secret key
  s3Bucket: string      // bucket name
  s3Region: string      // bucket region
  volumeName: string    // juicefs volume name
}

/** Sanitize userId for PG schema/role names (allows _ but not -) */
function sanitizeForPg(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9_]/g, '_')
}

/** Sanitize userId for JuiceFS volume names (allows - but not _, 3-63 chars) */
function sanitizeForVolume(userId: string): string {
  return userId.replace(/[^a-zA-Z0-9-]/g, '-')
}

/** Build PG DSN using per-user role credentials (NOT master password) */
function pgDsn(roleName: string, rolePassword: string, schemaName: string): string {
  const { pgHost, pgPort, pgDatabase } = config.juicefs
  return `postgres://${roleName}:${encodeURIComponent(rolePassword)}@${pgHost}:${pgPort}/${pgDatabase}?search_path=${schemaName}`
}

// ── PG Role + Schema ──

interface PgRoleCredentials {
  roleName: string
  rolePassword: string
}

/**
 * Create a per-user PG role and schema.
 * The role can only access its own schema — no access to public or other schemas.
 */
async function createPgRoleAndSchema(schemaName: string, pgId: string): Promise<PgRoleCredentials> {
  const roleName = `juicefs_user_${pgId}`
  const rolePassword = randomBytes(24).toString('base64url')

  const { error } = await getSupabase().rpc('provision_juicefs_role', {
    role_name: roleName,
    role_password: rolePassword,
    schema_name: schemaName,
  })

  if (error) {
    throw new Error(`Failed to create PG role/schema ${roleName}/${schemaName}: ${error.message}`)
  }
  slog('PG role and schema created', { roleName, schemaName })

  return { roleName, rolePassword }
}

// ── S3 IAM ──

interface IAMCredentials {
  accessKeyId: string
  secretAccessKey: string
}

async function createIAMUser(userId: string, sanitizedId: string, volumeName: string): Promise<IAMCredentials> {
  const iamUserName = `meios-jfs-${sanitizedId}`
  const bucket = config.juicefs.s3Bucket

  // 1. Create IAM user (idempotent)
  try {
    await iam.send(new CreateUserCommand({ UserName: iamUserName }))
    slog('IAM user created', { iamUserName })
  } catch (err: any) {
    if (err.name === 'EntityAlreadyExistsException') {
      slog('IAM user already exists', { iamUserName })
    } else {
      throw err
    }
  }

  // 2. Attach inline policy: scope to volume's S3 prefix
  const policyDocument = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucket}/${volumeName}/*`],
      },
      {
        Effect: 'Allow',
        Action: 's3:ListBucket',
        Resource: `arn:aws:s3:::${bucket}`,
        Condition: {
          StringLike: { 's3:prefix': [`${volumeName}/*`] },
        },
      },
    ],
  })

  await iam.send(new PutUserPolicyCommand({
    UserName: iamUserName,
    PolicyName: 'juicefs-access',
    PolicyDocument: policyDocument,
  }))
  slog('IAM policy attached', { iamUserName })

  // 3. Get or create access key
  const stored = await getStoredCredentials(userId)
  if (stored?.s3AccessKeyId) {
    slog('using stored IAM credentials', { iamUserName })
    return { accessKeyId: stored.s3AccessKeyId, secretAccessKey: stored.s3SecretAccessKey }
  }

  // Delete any existing keys (we can't retrieve the secret after creation)
  const listResp = await iam.send(new ListAccessKeysCommand({ UserName: iamUserName }))
  for (const key of listResp.AccessKeyMetadata ?? []) {
    await iam.send(new DeleteAccessKeyCommand({
      UserName: iamUserName,
      AccessKeyId: key.AccessKeyId,
    }))
  }

  // Create new access key
  const createResp = await iam.send(new CreateAccessKeyCommand({ UserName: iamUserName }))
  const creds: IAMCredentials = {
    accessKeyId: createResp.AccessKey!.AccessKeyId!,
    secretAccessKey: createResp.AccessKey!.SecretAccessKey!,
  }
  slog('IAM access key created', { iamUserName, accessKeyId: creds.accessKeyId })

  return creds
}

// ── Credentials storage ──

interface StoredCredentials {
  s3AccessKeyId: string
  s3SecretAccessKey: string
  pgRole: string | null
  pgPassword: string | null
}

async function getStoredCredentials(userId: string): Promise<StoredCredentials | null> {
  const { data, error } = await getSupabase()
    .from('juicefs_credentials')
    .select('s3_access_key_id, s3_secret_access_key, pg_role, pg_password')
    .eq('user_id', userId)
    .single()

  if (error || !data) return null
  return {
    s3AccessKeyId: data.s3_access_key_id,
    s3SecretAccessKey: data.s3_secret_access_key,
    pgRole: data.pg_role,
    pgPassword: data.pg_password,
  }
}

async function storeCredentials(
  userId: string,
  schemaName: string,
  iamCreds: IAMCredentials,
  pgCreds: PgRoleCredentials,
): Promise<void> {
  const { error } = await getSupabase()
    .from('juicefs_credentials')
    .upsert({
      user_id: userId,
      pg_schema: schemaName,
      pg_role: pgCreds.roleName,
      pg_password: pgCreds.rolePassword,
      s3_access_key_id: iamCreds.accessKeyId,
      s3_secret_access_key: iamCreds.secretAccessKey,
      s3_bucket: config.juicefs.s3Bucket,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' })

  if (error) throw new Error(`Failed to store JuiceFS credentials: ${error.message}`)
}

// ── Provisioning lock ──
// Prevent concurrent provisioning for the same user (avoids orphaned IAM keys)
const provisioningLocks = new Map<string, Promise<JuiceFSCredentials>>()

// ── Public API ──

/**
 * Provision JuiceFS infrastructure for a user.
 * Idempotent: safe to call multiple times for the same user.
 * Serialized per-user: concurrent calls for the same user share the same promise.
 *
 * Creates:
 * 1. PG role (per-user, isolated) + schema
 * 2. S3 IAM user with scoped credentials
 *
 * `juicefs format` runs in the sandbox entrypoint on first mount.
 *
 * Returns credentials for the sandbox to mount.
 */
export async function provisionJuiceFS(userId: string): Promise<JuiceFSCredentials> {
  // Serialize concurrent provisioning for the same user
  const existing = provisioningLocks.get(userId)
  if (existing) {
    slog('waiting for in-flight provisioning', { userId })
    return existing
  }

  const promise = doProvisionJuiceFS(userId)
  provisioningLocks.set(userId, promise)
  try {
    return await promise
  } finally {
    provisioningLocks.delete(userId)
  }
}

async function doProvisionJuiceFS(userId: string): Promise<JuiceFSCredentials> {
  const pgId = sanitizeForPg(userId)
  const schemaName = `juicefs_${pgId}`
  const volumeName = `user-${sanitizeForVolume(userId)}`

  slog('provisioning JuiceFS for user', { userId, schemaName })

  // Fast path: check for existing credentials (with per-user PG role)
  const stored = await getStoredCredentials(userId)
  if (stored?.pgRole && stored.pgPassword) {
    slog('using existing JuiceFS credentials', { userId })
    return {
      metaUrl: pgDsn(stored.pgRole, stored.pgPassword, schemaName),
      s3AccessKey: stored.s3AccessKeyId,
      s3SecretKey: stored.s3SecretAccessKey,
      s3Bucket: config.juicefs.s3Bucket,
      s3Region: config.juicefs.s3Region,
      volumeName,
    }
  }

  // 1. Create PG role + schema (per-user isolated)
  const pgCreds = await createPgRoleAndSchema(schemaName, pgId)

  // 2. Create S3 IAM user + credentials
  const iamCreds = await createIAMUser(userId, pgId, volumeName)

  // 3. Store all credentials for future use
  await storeCredentials(userId, schemaName, iamCreds, pgCreds)

  slog('JuiceFS provisioned', { userId, schemaName })
  return {
    metaUrl: pgDsn(pgCreds.roleName, pgCreds.rolePassword, schemaName),
    s3AccessKey: iamCreds.accessKeyId,
    s3SecretKey: iamCreds.secretAccessKey,
    s3Bucket: config.juicefs.s3Bucket,
    s3Region: config.juicefs.s3Region,
    volumeName,
  }
}
