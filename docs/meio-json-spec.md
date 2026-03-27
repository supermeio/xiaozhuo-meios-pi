# meio.json Spec

> Version: 0.1.0 · Updated: 2026-03-27

meio.json is the manifest file for a meio template. It declares what a meio is,
what it needs, and what it's allowed to do. The gateway reads this file at
provisioning time and at session creation time.

## Location

```
/persistent/meios/{type}/meio.json
```

For the default meio (legacy single-meio mode), no meio.json is required.

## Schema

```jsonc
{
  "$schema": "https://meios.ai/schemas/meio.json",  // editor autocomplete

  // ── Identity ──
  "id": "reader",                          // required, [a-z0-9-], unique per user
  "name": "Reading Assistant",             // required, human-readable display name
  "version": "0.1.0",                      // required, semver
  "description": "Summarize web articles to Google Docs",  // optional

  // ── Personality ──
  "soul": "SOUL.md",                       // optional, default "SOUL.md"
                                           // relative to meio directory

  // ── Tools ──
  "tools": {
    "builtin": ["coding"],                 // optional, default ["coding"]
                                           // "coding" = read, write, edit, bash
                                           // future: "web", "image", etc.
    "custom": "tools.ts"                   // optional, path to custom tool definitions
                                           // relative to meio directory
                                           // null = no custom tools
  },

  // ── Secrets ──
  // Declares external credentials this meio needs.
  // Credentials are stored per-user via PUT /api/v1/credentials/:service
  // and injected by the gateway credential proxy at runtime.
  // The meio never sees raw credentials.
  "secrets": {
    "google": {
      "description": "Google Service Account key (JSON)",
      "required": true,
      "setupUrl": "https://meios.ai/docs/setup/google-sa"
    }
  },

  // ── Network ──
  // Domains the credential proxy will forward requests to for this meio.
  // Requests to unlisted domains are rejected.
  // Gateway merges this with a platform-level denylist.
  "allowedEndpoints": [
    "docs.googleapis.com",
    "sheets.googleapis.com",
    "www.googleapis.com",
    "content-docs.googleapis.com"
  ],

  // ── Model ──
  "model": {                               // optional, override platform default
    "default": "kimi-k2.5",               // model ID for normal usage
    "thinking": "minimal"                  // thinking level: "none", "minimal", "full"
  },

  // ── Session ──
  // Borrowed from openclaw's session management pattern.
  "session": {
    "scope": "per-sender",                 // "per-sender" (default) | "shared"
                                           // per-sender: each user gets isolated sessions
                                           // shared: all users share one session (future)
    "idle": {
      "resetAfterMinutes": 30              // optional, auto-reset session after idle
                                           // null = never auto-reset (default)
    }
  },

  // ── Env ──
  // Non-secret environment variables injected into the sandbox at session start.
  // For secrets, use the "secrets" field instead (credential proxy path).
  "env": {
    "MEIO_LOCALE": "zh-CN",               // optional, static key-value pairs
    "MEIO_OUTPUT_FORMAT": "markdown"
  },

  // ── Storage ──
  "storage": {
    "directories": ["articles", "summaries"]  // optional, created at provisioning
                                              // relative to /persistent/meios/{id}/
  },

  // ── Metadata ──
  "author": "meios-team",                  // optional
  "homepage": "https://github.com/supermeio/meio-reader",  // optional
  "license": "MIT"                         // optional
}
```

## Field Reference

### Identity

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier, `[a-z0-9-]+`, max 40 chars. Used as directory name and meioType parameter. |
| `name` | string | yes | Display name shown in UI and `GET /meios` response. |
| `version` | string | yes | Semver. Gateway does not enforce version ordering; this is for human/agent reference. |
| `description` | string | no | One-line description. |

### Personality

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `soul` | string | `"SOUL.md"` | Path to personality file, relative to meio directory. |

### Tools

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `tools.builtin` | string[] | `["coding"]` | Platform-provided tool sets to include. |
| `tools.custom` | string \| null | null | Path to custom tool definitions file. Loaded at session creation. |

Builtin tool sets:

| Set | Tools included |
|-----|---------------|
| `coding` | `read_file`, `write_file`, `edit_file`, `bash` |

Custom tools follow the `ToolDefinition` interface from pi-coding-agent.
Dynamic loading (`tools.custom`) is a future capability — currently tools are
resolved by `resolveCustomTools()` in gateway.ts based on meioType.

### Secrets

```jsonc
"secrets": {
  "<service>": {
    "description": "string",    // human-readable, shown during onboarding
    "required": true | false,   // if true, provisioning warns when missing
    "setupUrl": "string"        // optional, link to setup instructions
  }
}
```

`<service>` matches the `:service` parameter in `PUT /api/v1/credentials/:service`.
The gateway checks `user_credentials` at provisioning time and returns missing
credentials in the response.

### Network

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowedEndpoints` | string[] | `[]` | Domains the credential proxy forwards to. Empty = no proxy access. |

The credential proxy (`POST /internal/v1/proxy`) validates the target URL's
hostname against this list. Currently the proxy uses a hardcoded allowlist;
once meio.json is loaded, the proxy will read from the meio's manifest.

### Model

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `model.default` | string | platform default | LiteLLM model ID. |
| `model.thinking` | string | `"minimal"` | `"none"`, `"minimal"`, or `"full"`. |

### Session

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `session.scope` | string | `"per-sender"` | `"per-sender"` (isolated sessions per user) or `"shared"` (single session, future). |
| `session.idle.resetAfterMinutes` | number \| null | null | Auto-reset session after N minutes idle. null = never. |

Borrowed from openclaw's session management. Most meios use `per-sender` (the
default). `shared` mode is reserved for future multi-user collaboration scenarios.

### Env

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `env` | Record<string, string> | `{}` | Non-secret environment variables injected at session start. |

For **secrets** (API keys, service account keys), use the `secrets` field instead —
those flow through the credential proxy and are never exposed to the sandbox.
`env` is for non-sensitive configuration like locale, output format, feature flags.

### Storage

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `storage.directories` | string[] | `[]` | Directories created at provisioning time, relative to meio root. |

## Validation Rules

1. `id` must match `/^[a-z0-9][a-z0-9-]*$/` and be ≤ 40 characters
2. `id` must not conflict with reserved names: `default`, `internal`, `api`, `system`
3. `version` must be valid semver
4. `allowedEndpoints` entries must be valid hostnames (no paths, no protocols)
5. `secrets` keys must match `/^[a-z0-9_]+$/`
6. `tools.custom` path must not escape the meio directory (no `../`)
7. `env` keys must match `/^[A-Z][A-Z0-9_]*$/` (uppercase convention)
8. `env` values must not contain credential-like patterns (gateway rejects on best-effort basis)
9. `session.idle.resetAfterMinutes` must be ≥ 5 if set

## Examples

### Wardrobe Meio

```json
{
  "$schema": "https://meios.ai/schemas/meio.json",
  "id": "wardrobe",
  "name": "穿搭助手",
  "version": "0.1.0",
  "description": "Closet management and outfit generation",
  "tools": {
    "builtin": ["coding"],
    "custom": "tools.ts"
  },
  "secrets": {},
  "allowedEndpoints": [],
  "storage": {
    "directories": ["closet", "looks"]
  }
}
```

### Reader Meio

```json
{
  "$schema": "https://meios.ai/schemas/meio.json",
  "id": "reader",
  "name": "Reading Assistant",
  "version": "0.1.0",
  "description": "Summarize web articles to Google Docs",
  "tools": {
    "builtin": ["coding"]
  },
  "secrets": {
    "google": {
      "description": "Google Service Account key (JSON)",
      "required": true,
      "setupUrl": "https://meios.ai/docs/setup/google-sa"
    }
  },
  "allowedEndpoints": [
    "docs.googleapis.com",
    "sheets.googleapis.com",
    "www.googleapis.com",
    "content-docs.googleapis.com"
  ],
  "storage": {
    "directories": ["articles", "summaries"]
  }
}
```

## Gateway Integration

### How the gateway uses meio.json

1. **Provisioning** (`POST /api/v1/meios`): reads meio.json from template,
   creates directories, checks credential requirements, registers meio.

2. **Session creation** (`getOrCreateSession`): reads meio.json from
   `/persistent/meios/{type}/meio.json` to resolve tools, model, and
   allowedEndpoints.

3. **Credential proxy** (`POST /internal/v1/proxy`): reads `allowedEndpoints`
   from meio.json to validate target domain. Replaces current hardcoded
   `ALLOWED_HOSTS`.

4. **Meio listing** (`GET /meios`): reads meio.json for name and description
   instead of inferring from directory structure.

### Migration from current hardcoded behavior

| Current | After meio.json |
|---------|----------------|
| `resolveCustomTools()` switch on meioType | Read `tools.custom` from meio.json |
| `ALLOWED_HOSTS` Set in credential-proxy.ts | Read `allowedEndpoints` from meio.json |
| `GET /meios` scans directory + checks `hasSoul` | Read `name`, `description` from meio.json |
| No credential requirement checking | Check `secrets` against `user_credentials` |

## TypeScript Type

```typescript
interface MeioManifest {
  $schema?: string
  id: string
  name: string
  version: string
  description?: string
  soul?: string
  tools?: {
    builtin?: string[]
    custom?: string | null
  }
  secrets?: Record<string, {
    description: string
    required?: boolean
    setupUrl?: string
  }>
  allowedEndpoints?: string[]
  model?: {
    default?: string
    thinking?: 'none' | 'minimal' | 'full'
  }
  session?: {
    scope?: 'per-sender' | 'shared'
    idle?: {
      resetAfterMinutes?: number | null
    }
  }
  env?: Record<string, string>
  storage?: {
    directories?: string[]
  }
  author?: string
  homepage?: string
  license?: string
}
```
