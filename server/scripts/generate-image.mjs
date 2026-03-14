#!/usr/bin/env node
/**
 * Generate images via Gemini Image API through LiteLLM proxy.
 *
 * Usage:
 *   node generate-image.mjs --prompt "white t-shirt on white background" --filename output.png
 *   node generate-image.mjs --prompt "..." --filename out.png --aspect-ratio 9:16 --quality pro
 *
 * Environment:
 *   OPENAI_BASE_URL  — LiteLLM proxy URL (required)
 *   OPENAI_API_KEY   — LiteLLM virtual key (required)
 *
 * Output:
 *   Saves image to the specified filename path.
 *   Prints the saved path on success.
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { parseArgs } from 'node:util'

const ASPECT_RATIOS = ['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']

const { values } = parseArgs({
  options: {
    prompt:        { type: 'string', short: 'p' },
    filename:      { type: 'string', short: 'f' },
    'aspect-ratio': { type: 'string', short: 'a' },
    quality:       { type: 'string', short: 'q', default: 'standard' },
  },
  strict: true,
})

const prompt = values.prompt
const filename = values.filename
const aspectRatio = values['aspect-ratio'] ?? '3:4'
const quality = values.quality ?? 'standard'

if (!prompt || !filename) {
  console.error('Usage: node generate-image.mjs --prompt "..." --filename output.png')
  process.exit(1)
}

if (values['aspect-ratio'] && !ASPECT_RATIOS.includes(values['aspect-ratio'])) {
  console.error(`Invalid aspect ratio. Options: ${ASPECT_RATIOS.join(', ')}`)
  process.exit(1)
}

const baseUrl = process.env.OPENAI_BASE_URL
const apiKey = process.env.OPENAI_API_KEY
if (!baseUrl || !apiKey) {
  console.error('Error: OPENAI_BASE_URL and OPENAI_API_KEY must be set')
  process.exit(1)
}

const modelId = quality === 'pro'
  ? 'gemini-3-pro-image-preview'
  : 'gemini-3.1-flash-image-preview'

console.log(`Generating image with ${modelId}...`)
console.log(`  Prompt: ${prompt}`)
console.log(`  Aspect ratio: ${aspectRatio}`)

try {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      messages: [{ role: 'user', content: prompt }],
      modalities: ['text', 'image'],
      ...(aspectRatio !== '1:1' ? { aspect_ratio: aspectRatio } : {}),
    }),
  })

  if (!response.ok) {
    const errBody = await response.text()
    console.error(`API error (${response.status}): ${errBody.slice(0, 300)}`)
    process.exit(1)
  }

  const result = await response.json()
  const message = result?.choices?.[0]?.message ?? {}

  // Extract image data — LiteLLM returns in message.images[]
  let imageData = null
  let mimeType = 'image/png'

  const images = message?.images ?? []
  if (images.length > 0) {
    const imgUrl = images[0]?.image_url?.url ?? ''
    const match = imgUrl.match(/^data:([^;]+);base64,(.+)$/)
    if (match) {
      mimeType = match[1]
      imageData = match[2]
    }
  }

  // Fallback: check content array
  if (!imageData && Array.isArray(message.content)) {
    for (const part of message.content) {
      if (part.type === 'image_url' && part.image_url?.url) {
        const match = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/)
        if (match) {
          mimeType = match[1]
          imageData = match[2]
          break
        }
      }
    }
  }

  if (!imageData) {
    console.error('No image generated in response.')
    console.error('Response:', JSON.stringify(result).slice(0, 500))
    process.exit(1)
  }

  // Save image
  const outputPath = resolve(filename)
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, Buffer.from(imageData, 'base64'))

  const sizeKb = Math.round(Buffer.from(imageData, 'base64').length / 1024)
  console.log(`\nImage saved: ${outputPath} (${sizeKb}KB)`)

} catch (err) {
  console.error(`Error: ${err.message}`)
  process.exit(1)
}
