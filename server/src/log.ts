/**
 * Unified logger for the sandbox server, powered by tslog.
 *
 * Usage:
 *   import { logger } from './log.js'
 *   const log = logger.getSubLogger({ name: 'sync' })
 *   log.info('uploaded', { path })
 *   log.error('failed', err)
 *
 * Log level controlled by LOG_LEVEL env var (default: "info").
 */

import { Logger } from 'tslog'

const LEVEL_MAP: Record<string, number> = {
  silly: 0, trace: 1, debug: 2, info: 3, warn: 4, error: 5, fatal: 6,
}

const level = LEVEL_MAP[process.env.LOG_LEVEL ?? 'info'] ?? 3

export const logger = new Logger({
  name: 'sandbox',
  minLevel: level,
  type: 'json',
})
