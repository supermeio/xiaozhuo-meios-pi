# Sandbox Startup Optimization

## Background

meios sandbox runs on Fly.io Machines with JuiceFS (networked filesystem).
The agent framework (`@mariozechner/pi-coding-agent`) is designed for local CLI usage
where disk I/O is fast. On JuiceFS, every `existsSync` / `readdirSync` is a remote call,
making the framework's startup path extremely slow.

## Problem: `resourceLoader.reload()` takes 64 seconds

`createAgentSession()` internally creates a `DefaultResourceLoader` and calls `reload()`,
which does heavy directory scanning:

```
reload()
├── packageManager.resolve()              ← scans npm packages, resolves deps
│   ├── getGlobalSettings()               ← reads ~/.pi/agent/settings.json
│   ├── getProjectSettings()              ← reads .agents/settings.json
│   ├── resolvePackageSources()           ← downloads/installs npm extensions
│   └── addAutoDiscoveredResources()      ← recursive directory scan
│       ├── cwd/.agents/extensions/
│       ├── cwd/.agents/skills/
│       ├── cwd/.agents/prompts/
│       ├── cwd/.agents/themes/
│       ├── ~/.pi/agent/extensions/
│       ├── ~/.pi/agent/skills/
│       └── walks from cwd up to / looking for .agents/skills/
├── loadExtensions()                      ← dynamically loads JS extensions
├── loadSkills()                          ← parses SKILL.md files
├── loadPromptTemplates()                 ← parses prompt templates
├── loadThemes()                          ← loads UI themes
└── loadProjectContextFiles()             ← finds CLAUDE.md / AGENTS.md
```

On local SSD (e.g., openclaw): completes in seconds.
On JuiceFS (meios sandbox): **64 seconds**.

## Solution: Skip `reload()` entirely

We don't use any of these features:
- No skills (yet — see "Future: Skills Support" below)
- No extensions
- No prompt templates
- No themes
- System prompt is loaded from SOUL.md + MEMORY.md via our own `loadSystemPrompt()`

### What we do instead

1. **Create a lightweight `DefaultResourceLoader`** with all discovery disabled:
   ```typescript
   const resourceLoader = new DefaultResourceLoader({
     cwd: AGENT_DIR,        // ephemeral disk, NOT /persistent (JuiceFS)
     agentDir: AGENT_DIR,
     settingsManager,
     noExtensions: true,
     noSkills: true,
     noPromptTemplates: true,
     noThemes: true,
   })
   // Do NOT call reload() — not needed
   ```

2. **Pass it to `createAgentSession()`** so the library skips its own creation + reload:
   ```typescript
   const { session } = await createAgentSession({
     cwd: AGENT_DIR,        // avoid JuiceFS scans
     agentDir: AGENT_DIR,
     resourceLoader,        // pre-created, no reload
     settingsManager,
     // ...
   })
   ```

3. **Set system prompt per request** via the correct API:
   ```typescript
   session.agent.setSystemPrompt(loadSystemPrompt())
   ```
   Note: `PromptOptions` does NOT support `systemPrompt` — passing it as an option is silently ignored.

## Results

Cold start (from stopped machine to first token):

| Stage | Before | After |
|-------|--------|-------|
| Firecracker boot | 2s | 2s |
| JuiceFS mount | 7s | 7s |
| Node.js → gateway ready | 14s | 14s |
| `resourceLoader.reload()` | **64s** | **0s (skipped)** |
| `getOrCreateSession()` | **hang (5min+)** | **233ms** |
| `loadSystemPrompt()` | N/A | 21ms |
| `session.prompt()` → first token | N/A | 59ms |
| **Total** | **88s+ or hang** | **~24s** |

With `autostop=suspend` (resume from memory snapshot):

| Stage | Time |
|-------|------|
| Firecracker resume | 336ms–467ms |
| `getOrCreateSession()` | 151ms |
| `loadSystemPrompt()` | 21ms (cached) – 6.5s (stale JuiceFS) |
| `session.prompt()` → first token | 59ms |
| **Total** | **~1s – 7s** |

## Why openclaw doesn't have this problem

openclaw runs pi-coding-agent on persistent VMs with local SSD:
- Process stays running (systemd), no cold start per request
- `reload()` scans local disk: seconds, not minutes
- No Firecracker, no JuiceFS mount

## Future: Skills Support

When we need skills in sandbox, do NOT re-enable `reload()`. Instead:

**Option A: Build-time (Docker image)**
```typescript
// Pack skills into image at /app/skills/
const resourceLoader = new DefaultResourceLoader({
  additionalSkillPaths: ['/app/skills'],  // local disk, instant
  noSkills: true,  // disable auto-discovery, only use additionalSkillPaths
})
```

**Option B: On-demand from JuiceFS**
Read SKILL.md from `/persistent/skills/` when user enables a skill.
Cache in memory. Inject into system prompt.

**Option C: Inject into system prompt directly**
```typescript
const skills = readFileSync('/persistent/skills/weather/SKILL.md', 'utf-8')
session.agent.setSystemPrompt(systemPrompt + '\n\n' + skills)
```

Core principle: **know where your files are and read them directly.
Never let the framework "discover" them via recursive directory scanning on networked storage.**
