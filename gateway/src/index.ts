import { serve } from '@hono/node-server'
import { config } from './config.js'
import { log } from './log.js'
import { app } from './app.js'

serve({ fetch: app.fetch, port: config.port }, (info) => {
  log('gateway', 'meios auth gateway running', {
    port: info.port,
    supabase: config.supabase.url,
  })
})
