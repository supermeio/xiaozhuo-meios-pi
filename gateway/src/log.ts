/**
 * Unified logger for the gateway, powered by tslog.
 *
 * Usage:
 *   import { logger } from './log.js'
 *   const log = logger.getSubLogger({ name: 'proxy' })
 *   log.info('request start', { path, userId })
 *   log.error('failed', err)
 *
 * Log level controlled by LOG_LEVEL env var (default: "info").
 * Valid levels: silly, trace, debug, info, warn, error, fatal.
 */

import { Logger } from 'tslog'

const LEVEL_MAP: Record<string, number> = {
  silly: 0, trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6,
}

const level = LEVEL_MAP[process.env.LOG_LEVEL ?? 'info'] ?? 3

export const logger = new Logger({
  name: 'gateway',
  minLevel: level,
  type: 'json',
})

// ── Backward-compatible helpers ──────────────────────────────
// These match the old log(component, msg, data) signature so existing
// call sites don't need to change immediately.

export function log(component: string, msg: string, data?: Record<string, unknown>) {
  logger.info({ component, ...data }, msg)
}

export function logError(component: string, msg: string, error?: unknown, data?: Record<string, unknown>) {
  const errMsg = error instanceof Error ? error.message : String(error ?? '')
  logger.error({ component, error: errMsg, ...data }, msg)
}
