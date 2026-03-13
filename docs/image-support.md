# Image Support

> Default image generation, storage, and delivery infrastructure for meios apps.

meios is a lightweight agent runtime. This doc describes the **built-in image support** that any vertical app (wardrobe styling, food journaling, travel photos, etc.) gets out of the box.

---

## Architecture

```
Sandbox Agent
  │ generate (Google Gemini API)
  │ save to workspace/
  │
  ├── chokidar watches workspace/ ──→ auto-sync to R2
  │
Cloudflare R2 (images.meios.ai)
  │ CDN edge delivery, zero egress cost
  │
iOS App (NukeUI renders content blocks)
```

Three layers, each with a clear job:

| Layer | Role | Technology |
|-------|------|------------|
| **Generation** | Create images from prompts | Google Gemini native image gen (Nano Banana 2 / Pro) |
| **Storage & Sync** | Persist images, deliver to clients | Cloudflare R2 + chokidar file watcher |
| **Display** | Render rich content in conversation | Content block protocol + NukeUI (iOS) |

---

## 1. Image Generation

### Models

| Model | ID | Speed | Quality | Cost (1K) | Use when |
|-------|----|-------|---------|-----------|----------|
| **Nano Banana 2** | `gemini-3.1-flash-image-preview` | 4-6s | High | ~$0.067 | Default — fast, cheap |
| **Nano Banana Pro** | `gemini-3-pro-image-preview` | 10-20s | Highest | ~$0.15 | Quality-critical (hero images, final outfits) |

Both are Google Gemini native image generation models, called via the same API.

### Supported Parameters

**Resolutions:** 512px, 1K, 2K (default), 4K

**Aspect ratios (Nano Banana 2, 14 options):**
`1:1, 2:3, 3:2, 3:4, 4:3, 4:5, 5:4, 9:16, 16:9, 21:9, 1:4, 4:1, 1:8, 8:1, auto`

Nano Banana Pro supports 10 of the above (excludes `1:4, 4:1, 1:8, 8:1, auto`).

### API Call

```javascript
import { GoogleGenAI } from '@google/genai'

const client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })

const response = await client.models.generateContent({
  model: 'gemini-3.1-flash-image-preview',  // Nano Banana 2
  contents: 'A casual spring outfit with a navy blazer',
  config: { responseModalities: ['TEXT', 'IMAGE'] }
})

for (const part of response.candidates[0].content.parts) {
  if (part.inlineData) {
    fs.writeFileSync('workspace/outfits/outfit.webp', Buffer.from(part.inlineData.data, 'base64'))
  }
}
```

### Routing via LiteLLM

These models route through our existing LiteLLM proxy. No new API keys needed — uses the Google API key already configured.

---

## 2. Storage & Sync

### Design Principles

- **Sandbox filesystem is the agent's workspace** — agents read/write files naturally (`ls`, `cp`, `mv`, `sharp`, etc.)
- **Cloudflare R2 is the delivery layer** — iOS loads images from CDN, not from sandbox
- **Sync is automatic and invisible** — agent doesn't need to know about R2

### File Sync: chokidar + S3 SDK

The sandbox runs a file watcher that auto-syncs `workspace/` to R2:

```
sandbox server startup
  ├── reconcile()           // full diff on boot (catches anything missed during sleep)
  ├── chokidar.watch()      // real-time fs monitoring
  │     ├── add/change  → PutObject to R2
  │     ├── unlink      → DeleteObject from R2
  │     └── debounce 500ms (wait for writes to finish)
  └── agent works normally, writes files, sync is invisible
```

**Key behaviors:**
- **Boot reconcile** — on sandbox wake, compare local manifest vs R2 listing, sync any gaps
- **Real-time watch** — chokidar uses Linux inotify (zero CPU overhead), triggers S3 SDK calls
- **Local manifest** — lightweight JSON tracking `{ path, size, mtime, etag }` per synced file
- **Debounce** — 500ms settle time prevents uploading half-written files

### R2 Bucket Layout

```
meios-images/
  {user_id}/
    closet/
      top-001.webp
      pants-002.webp
    outfits/
      2026-03-14/
        outfit-abc.webp
    ...
```

Developers organize files however they want in `workspace/`. The sync preserves the directory structure as R2 key prefixes.

### Cloudflare Setup

- Bucket: `meios-images`
- Custom domain: `images.meios.ai` → R2 bucket (Cloudflare one-click)
- R2 API token (S3 auth): injected as env var in sandbox
- Lifecycle rule: auto-delete generated images older than 90 days (configurable)

### Cost (at 10K users, 20 images/day)

| Item | Cost/month |
|------|-----------|
| Storage (3TB new) | $45 |
| Operations (PUT/GET) | ~$34 |
| Egress | $0 |
| **Total** | **~$79** |

For comparison: Supabase Storage ~$340/mo, Cloudinary ~$500-2000/mo at same scale.

---

## 3. Content Block Protocol

### The Problem

Agent responses are not just text — they contain images, and eventually audio, files, action buttons, etc. A flat `reply: string` can't represent this.

### The Solution

Responses are an **array of typed content blocks** (same pattern as OpenAI, Anthropic, iMessage):

```json
{
  "sessionId": "s-123",
  "content": [
    { "type": "text", "text": "Here's an outfit for today's weather..." },
    {
      "type": "image",
      "url": "https://images.meios.ai/{user_id}/outfits/outfit-abc.webp",
      "imageId": "outfit-abc",
      "width": 768,
      "height": 1024,
      "alt": "Casual spring outfit with navy blazer"
    },
    { "type": "text", "text": "The blazer pairs well with the chinos..." }
  ]
}
```

### Block Types (v0.2.0)

| Type | Fields | Description |
|------|--------|-------------|
| `text` | `text` | Markdown text |
| `image` | `url`, `imageId`, `width?`, `height?`, `alt?` | Image with stable cache key |

Future types (`audio`, `file`, `action`, etc.) are just new entries — no protocol changes needed.

### Backward Compatibility

Server returns both fields during migration:

```json
{
  "reply": "Here's an outfit for today's weather...",
  "content": [ ... ]
}
```

iOS checks `content` first, falls back to wrapping `reply` as a single text block.

---

## 4. iOS Rendering

### Image Loading: NukeUI

[NukeUI](https://github.com/kean/Nuke) handles signed URL caching, progressive loading, and disk persistence.

Key advantage: **stable cache key** separate from URL. R2 signed URLs expire, but the image doesn't change — NukeUI caches by `imageId`, not by URL.

```swift
let request = ImageRequest(
    url: signedURL,
    userInfo: [.imageIdKey: imageInfo.imageId]  // stable cache key
)

LazyImage(request: request) { state in
    if let image = state.image {
        image.resizable().aspectRatio(contentMode: .fit)
    } else {
        ShimmerPlaceholder()
    }
}
```

### Message Model Change

```swift
// Before
struct Message {
    let text: String
}

// After
struct Message {
    let content: [ContentBlock]
    var text: String { /* backward-compat accessor */ }
}

enum ContentBlock {
    case text(String)
    case image(ImageInfo)
}
```

### Interactions

- **Tap** → full-screen viewer with pinch-to-zoom
- **Long press** → context menu: Save to Photos, Share
- **Multiple images** → horizontal carousel with snap-to-page

---

## Implementation Plan

| Step | Scope | Description |
|------|-------|-------------|
| 1 | Server | Content block protocol — change `/chat` response format |
| 2 | iOS | Parse content blocks, backward-compat fallback |
| 3 | iOS | Add NukeUI, render image blocks in chat bubbles |
| 4 | Sandbox | Image generation tool (Nano Banana 2 via Gemini API) |
| 5 | Infra | R2 bucket + `images.meios.ai` domain setup |
| 6 | Sandbox | chokidar file watcher + S3 sync module |
| 7 | iOS | Full-screen viewer, save/share, carousel |

Steps 1-3 can be developed with mock image URLs before R2 is set up.
