/**
 * AES-256-GCM encryption for user credentials at rest.
 *
 * The encryption key lives in Gateway env vars only.
 * Supabase PG stores ciphertext + IV — even if the DB leaks,
 * credentials cannot be decrypted without the key.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'
const IV_LENGTH = 12
const AUTH_TAG_LENGTH = 16

export function encrypt(plaintext: string, key: Buffer): { ciphertext: Buffer; iv: Buffer } {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  const authTag = cipher.getAuthTag()
  // Append auth tag to ciphertext for storage
  return { ciphertext: Buffer.concat([encrypted, authTag]), iv }
}

export function decrypt(ciphertext: Buffer, iv: Buffer, key: Buffer): string {
  const authTag = ciphertext.subarray(ciphertext.length - AUTH_TAG_LENGTH)
  const data = ciphertext.subarray(0, ciphertext.length - AUTH_TAG_LENGTH)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(authTag)
  return decipher.update(data) + decipher.final('utf8')
}
