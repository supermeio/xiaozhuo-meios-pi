# CDN Image Delivery

meios uses Cloudflare R2 + CDN to serve user-generated images with zero egress cost.

## Architecture

```
Image generation:
  Fly.io sandbox → generate_image tool → write to JuiceFS (/persistent/images/)
                                       → sync.ts detects new file
                                       → uploads to Cloudflare R2

Image loading (iOS app):
  iOS app → https://images.meios.ai/{userId}/images/xxx.jpg
          → Cloudflare CDN edge (cached)
          → Cloudflare R2 (origin, zero egress)
```

## Why not serve images through the gateway?

The naive path would be:

```
iOS app → Cloud Run gateway → Fly Proxy → sandbox /files/* → JuiceFS → GCS
```

This has two problems:
1. **GCS egress costs** — every image load downloads from GCS (~$0.12/GB)
2. **Latency** — 4 hops, each adding latency

With R2 CDN:
1. **Zero egress** — Cloudflare R2 has no egress fees
2. **Edge caching** — repeat views served from nearest Cloudflare POP
3. **Direct path** — iOS app → CDN, no gateway/sandbox involvement

## How it works

### 1. File sync (sandbox → R2)

`server/src/sync.ts` runs inside each Fly.io sandbox:

- Uses [chokidar](https://github.com/paulmillr/chokidar) to watch the `images/` directory under the workspace
- On file create/change, uploads to R2 via S3-compatible API
- R2 key format: `{userId}/{relativePath}` (e.g., `4f48.../images/cute-cat.jpg`)
- Reconciles on startup (uploads any files missing from R2)
- Future: watchDirs will be user-configurable (similar to openclaw.json)

### 2. URL generation (sandbox → iOS)

When the sandbox generates content blocks (text + images), it checks if R2 is configured:

- **R2 configured** (`R2_PUBLIC_URL` set): emits `https://images.meios.ai/{userId}/{path}`
- **R2 not configured** (dev mode): falls back to `/files/{path}` (served by sandbox directly)

This logic lives in:
- `server/src/parsers.ts` — `imageUrl()` helper for content block parsing
- `server/src/gateway.ts` — `cdnUrl()` helper for SSE events and REST endpoints

### 3. CDN serving (Cloudflare)

- Domain: `images.meios.ai`
- DNS: Cloudflare Proxied → R2 bucket `meios-images`
- Cache: `public, max-age=86400` (24 hours)
- Image filenames include random suffixes, so cache invalidation is not needed

## Configuration

### Sandbox environment variables (injected by gateway during provisioning)

| Variable | Description | Example |
|----------|-------------|---------|
| `R2_ENDPOINT` | S3-compatible endpoint | `https://xxx.r2.cloudflarestorage.com` |
| `R2_ACCESS_KEY_ID` | R2 API key ID | `35551d...` |
| `R2_SECRET_ACCESS_KEY` | R2 API secret | `46841f...` |
| `R2_BUCKET` | Bucket name | `meios-images` |
| `R2_PUBLIC_URL` | CDN base URL | `https://images.meios.ai` |
| `MEIOS_USER_ID` | User ID (R2 key prefix) | `4f4812bd-...` |

### Cloudflare DNS

```
images.meios.ai  →  R2 bucket (meios-images)  →  Proxied
```

## Fallback

The `/files/*` endpoint on the sandbox is NOT removed. It serves as:
- Fallback when R2 sync hasn't caught up yet (race condition on new images)
- Dev mode serving when R2 is not configured (e.g., openclaw-001)
- Non-image file serving (markdown, data files)

## Cost

- **R2 storage**: $0.015/GB/month
- **R2 egress**: $0 (free)
- **Cloudflare CDN**: included with free plan
- **GCS egress saved**: ~$0.12/GB (no longer accessed for image serving)
