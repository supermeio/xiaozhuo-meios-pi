/**
 * meios heartbeat — proactive agent tasks
 *
 * Runs on a schedule, checks if there's anything worth telling the user.
 * Results are stored for the next chat session to pick up.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { registerTask } from './cron.js'

let workspaceRoot = ''

export function initHeartbeat(workspace: string, chatFn?: (input: string) => Promise<string>) {
  workspaceRoot = workspace

  // ── Heartbeat: run every 4 hours ──
  registerTask({
    id: 'heartbeat',
    description: '定期检查衣橱和记忆，生成主动建议',
    intervalMs: 4 * 60 * 60 * 1000,  // 4 hours
    async handler() {
      const suggestions = await runHeartbeat()
      if (suggestions) {
        // Save to a file so next chat can pick it up
        const outPath = resolve(workspaceRoot, 'memory', 'heartbeat-pending.md')
        const existing = existsSync(outPath) ? readFileSync(outPath, 'utf-8') : ''
        const content = existing
          ? existing.replace(/_生成时间:.*_\n?$/, '') + '\n---\n\n' + suggestions
          : suggestions
        writeFileSync(outPath, `# 待告知用户\n\n${content}\n\n_生成时间: ${new Date().toISOString()}_\n`)
        return `有新建议待告知`
      }
      return 'nothing to report'
    }
  })

  // ── Daily wardrobe review: run every 24 hours ──
  registerTask({
    id: 'wardrobe-review',
    description: '每日衣橱检视：季节性提醒',
    intervalMs: 24 * 60 * 60 * 1000,  // 24 hours
    async handler() {
      const review = checkSeasonalWardrobe()
      if (review) {
        const outPath = resolve(workspaceRoot, 'memory', 'wardrobe-review.md')
        writeFileSync(outPath, review)
        return '季节性衣橱检视完成'
      }
      return 'nothing to review'
    }
  })
}

// ── Heartbeat logic ──
function runHeartbeat(): string | null {
  const pendingPath = resolve(workspaceRoot, 'memory', 'heartbeat-pending.md')

  // Check if closet has items but no recent looks generated
  const closetDir = resolve(workspaceRoot, 'closet')
  const looksDir = resolve(workspaceRoot, 'looks')

  if (!existsSync(closetDir)) return null

  const clothingCount = readdirSync(closetDir).filter(f => f.endsWith('.md')).length
  const looksCount = existsSync(looksDir) ? readdirSync(looksDir).filter(f => f.endsWith('.md') || f.endsWith('.png')).length : 0

  const suggestions: string[] = []

  if (clothingCount > 0 && looksCount === 0) {
    suggestions.push('- 衣橱里有衣物但还没生成过搭配图，可以试试让我推荐一套！')
  }

  if (clothingCount < 5) {
    suggestions.push(`- 衣橱里只有 ${clothingCount} 件衣物，多添加一些可以让搭配更丰富`)
  }

  // Check memory for missing user preferences
  const memoryPath = resolve(workspaceRoot, 'MEMORY.md')
  if (existsSync(memoryPath)) {
    const memory = readFileSync(memoryPath, 'utf-8')
    if (memory.includes('待了解') || memory.includes('待用户')) {
      suggestions.push('- 还不太了解你的风格偏好，聊聊？')
    }
  }

  return suggestions.length > 0 ? suggestions.join('\n') : null
}

// ── Seasonal check ──
function checkSeasonalWardrobe(): string | null {
  const month = new Date().getMonth() + 1  // 1-12
  let currentSeason = ''
  if (month >= 3 && month <= 5) currentSeason = '春'
  else if (month >= 6 && month <= 8) currentSeason = '夏'
  else if (month >= 9 && month <= 11) currentSeason = '秋'
  else currentSeason = '冬'

  const closetDir = resolve(workspaceRoot, 'closet')
  if (!existsSync(closetDir)) return null

  const files = readdirSync(closetDir).filter(f => f.endsWith('.md'))
  let seasonalCount = 0

  for (const f of files) {
    const content = readFileSync(join(closetDir, f), 'utf-8')
    if (content.includes(currentSeason) || content.includes('四季')) {
      seasonalCount++
    }
  }

  if (seasonalCount === 0 && files.length > 0) {
    return `# 季节提醒\n\n当前季节: ${currentSeason}\n衣橱里没有标记为「${currentSeason}」季的衣物，可能需要补充。\n`
  }

  return null
}
