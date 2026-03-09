/**
 * meios cron — lightweight scheduled tasks
 *
 * No external dependencies, just setInterval + a task registry.
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'

export interface CronTask {
  id: string
  description: string
  intervalMs: number
  handler: () => Promise<string | void>
  lastRun?: number
  enabled: boolean
}

const tasks = new Map<string, CronTask>()
const timers = new Map<string, NodeJS.Timeout>()

// ── State persistence ──
let stateFile = ''

export function initCron(workspaceRoot: string) {
  stateFile = resolve(workspaceRoot, 'memory', 'cron-state.json')
  mkdirSync(resolve(workspaceRoot, 'memory'), { recursive: true })
  loadState()
}

function loadState() {
  if (!stateFile || !existsSync(stateFile)) return
  try {
    const data = JSON.parse(readFileSync(stateFile, 'utf-8'))
    for (const [id, lastRun] of Object.entries(data.lastRuns ?? {})) {
      const task = tasks.get(id)
      if (task) task.lastRun = lastRun as number
    }
  } catch { /* ignore */ }
}

function saveState() {
  if (!stateFile) return
  const lastRuns: Record<string, number> = {}
  for (const [id, task] of tasks) {
    if (task.lastRun) lastRuns[id] = task.lastRun
  }
  writeFileSync(stateFile, JSON.stringify({ lastRuns }, null, 2) + '\n')
}

// ── Task management ──
export function registerTask(task: Omit<CronTask, 'enabled'> & { enabled?: boolean }) {
  const full: CronTask = { ...task, enabled: task.enabled ?? true }
  tasks.set(task.id, full)
  if (full.enabled) startTask(task.id)
  return full
}

function startTask(id: string) {
  const task = tasks.get(id)
  if (!task) return

  // Stop existing timer if any
  stopTask(id)

  const run = async () => {
    try {
      const result = await task.handler()
      task.lastRun = Date.now()
      saveState()
      if (result) console.log(`[cron:${id}] ${result}`)
    } catch (err: any) {
      console.error(`[cron:${id}] error:`, err.message)
    }
  }

  // Run immediately if never run or overdue
  const overdue = !task.lastRun || (Date.now() - task.lastRun) > task.intervalMs
  if (overdue) run()

  timers.set(id, setInterval(run, task.intervalMs))
}

function stopTask(id: string) {
  const timer = timers.get(id)
  if (timer) { clearInterval(timer); timers.delete(id) }
}

export function enableTask(id: string) {
  const task = tasks.get(id)
  if (task) { task.enabled = true; startTask(id) }
}

export function disableTask(id: string) {
  const task = tasks.get(id)
  if (task) { task.enabled = false; stopTask(id) }
}

export function listTasks(): CronTask[] {
  return Array.from(tasks.values())
}

export function stopAll() {
  for (const id of timers.keys()) stopTask(id)
}
