export function log(component: string, msg: string, data?: Record<string, unknown>) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), component, msg, ...data }))
}

export function logError(component: string, msg: string, error?: unknown, data?: Record<string, unknown>) {
  const errMsg = error instanceof Error ? error.message : String(error ?? '')
  console.error(JSON.stringify({ ts: new Date().toISOString(), component, msg, error: errMsg, ...data }))
}
