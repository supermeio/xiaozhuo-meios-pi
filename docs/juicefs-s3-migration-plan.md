# JuiceFS S3 迁移实施计划

## 目标

从 JuiceFS Cloud (jfsmount + GCS) 迁移到自部署 JuiceFS (开源) + AWS S3。
实现 per-user credential 隔离，消除共享凭证安全风险，消除对 juicefs.com (中国) 的依赖。

## 前置条件（已完成）

- [x] AWS 账号创建，CLI 配置完成
- [x] S3 bucket `meios-juicefs` 创建于 `us-east-1`
- [x] Supabase IPv4 add-on 启用
- [x] `juicefs format` + Supabase PG + S3 链路验证通过
- [x] 测试数据已清理

## 架构变化

```
之前: gateway 注入共享 JUICEFS_TOKEN + JUICEFS_GCS_KEY_B64 → sandbox jfsmount 连 juicefs.com
之后: gateway 注入 per-user PG DSN + S3 credentials → sandbox juicefs (开源) 直连 PG + S3
```

### 凭证对比

| | 之前 (JuiceFS Cloud) | 之后 (自部署) |
|---|---|---|
| 元数据认证 | `JUICEFS_TOKEN` (共享) | PG DSN with `search_path=juicefs_{userId}` |
| 数据认证 | `JUICEFS_GCS_KEY_B64` (共享 GCS SA) | Per-user S3 IAM access key |
| 泄露影响 | 全部用户数据 | 仅该用户数据 |

## 实施步骤

### Step 1: 新增 `gateway/src/juicefs.ts` — per-user provisioning

新建模块，负责为新用户创建 JuiceFS volume：

```typescript
export async function provisionJuiceFS(userId: string): Promise<JuiceFSCredentials>
```

流程：
1. **创建 PG schema**: `CREATE SCHEMA IF NOT EXISTS juicefs_{sanitizedUserId}`
2. **创建 S3 IAM user**: `meios-jfs-{sanitizedUserId}`
   - IAM Policy: 只允许 `s3:*` on `arn:aws:s3:::meios-juicefs/{userId}/*`
   - 创建 access key
3. **调用 `juicefs format`**: 通过 shell exec（gateway 是 Node.js，没有 JuiceFS SDK）
   - meta: `postgres://...?search_path=juicefs_{userId}`
   - storage: s3, bucket: meios-juicefs
4. **返回凭证**: `{ pgDsn, s3AccessKey, s3SecretKey }`

凭证存储：存入 Supabase `sandboxes` 表新增字段，或新建 `juicefs_credentials` 表。

验证命令：
```bash
# 从 gateway 侧验证
psql $PG_DSN -c "SELECT * FROM juicefs_{userId}.jfs_setting;"
aws s3 ls s3://meios-juicefs/{userId}/
```

### Step 2: 修改 `gateway/src/config.ts` — 更新配置

删除：
- `flyio.juicefsToken`
- `flyio.gcsKeyB64`
- `flyio.juicefsVolume`

新增：
- `juicefs.pgHost` (Supabase 直连地址)
- `juicefs.pgPassword` (Supabase DB 密码)
- `juicefs.s3Bucket` (`meios-juicefs`)
- `juicefs.s3Region` (`us-east-1`)
- `juicefs.awsAccessKeyId` (admin IAM，用于创建 per-user IAM)
- `juicefs.awsSecretAccessKey`

Gateway 所需的 env vars：
```
SUPABASE_DB_HOST=db.exyqukzhnjhbypakhlsp.supabase.co
SUPABASE_DB_PASSWORD=***
JUICEFS_S3_BUCKET=meios-juicefs
AWS_ACCESS_KEY_ID=*** (admin)
AWS_SECRET_ACCESS_KEY=*** (admin)
```

验证：gateway 启动时 log 出新配置（密钥 masked）。

### Step 3: 修改 `gateway/src/flyio.ts` — 改注入 env vars

`createMachine()` 的 env 变更：

删除：
```typescript
JUICEFS_TOKEN: config.flyio.juicefsToken,
JUICEFS_GCS_KEY_B64: config.flyio.gcsKeyB64,
JUICEFS_VOLUME: config.flyio.juicefsVolume,
JUICEFS_SUBDIR: opts.userId,
```

新增：
```typescript
JUICEFS_META_URL: opts.juicefs.pgDsn,       // per-user PG DSN
AWS_ACCESS_KEY_ID: opts.juicefs.s3AccessKey,  // per-user S3 key
AWS_SECRET_ACCESS_KEY: opts.juicefs.s3SecretKey,
JUICEFS_S3_BUCKET: config.juicefs.s3Bucket,
```

验证：创建测试 machine，`flyctl ssh console` 检查 env vars。

### Step 4: 修改 `gateway/src/sandbox.ts` — provisioning 流程

在 `provisionFlyMachine()` 中，在创建 Fly Machine 之前调用 per-user JuiceFS provisioning：

```typescript
// 1. Create LiteLLM virtual key (existing)
// 2. NEW: Provision JuiceFS volume for user
const juicefs = await provisionJuiceFS(userId)
// 3. Create Fly Machine (pass juicefs credentials)
const { machineId, machineSecret } = await createMachine({
  userId,
  llmProxyUrl: proxyUrl,
  virtualKey,
  juicefs,  // NEW
})
```

需要处理幂等性：如果用户已有 JuiceFS volume（重新 provision 时），跳过 format，只返回已有凭证。

验证：调用 `provisionFlyMachine()` 两次，第二次应该复用已有 volume。

### Step 5: 修改 `server/Dockerfile` — 安装开源 juicefs

替换：
```dockerfile
# 旧: JuiceFS Cloud binary
RUN curl -sSL http://s.juicefs.com/static/Linux/mount -o /usr/local/bin/jfsmount && \
    chmod +x /usr/local/bin/jfsmount
```

为：
```dockerfile
# 新: JuiceFS 开源版 (自部署)
RUN curl -sSL https://d.juicefs.com/install | sh
```

这会安装 `juicefs` 到 `/usr/local/bin/juicefs`。

验证：`docker build` 后 `docker run --rm <image> juicefs version`。

### Step 6: 修改 `server/entrypoint.sh` — 新 mount 逻辑

替换整个 JuiceFS mount 部分：

```bash
# 新: 自部署 JuiceFS (开源) + S3
if [ -n "$JUICEFS_META_URL" ]; then
  mkdir -p /persistent

  echo "[entrypoint] mounting JuiceFS (self-hosted)..."
  /usr/local/bin/juicefs mount "$JUICEFS_META_URL" /persistent \
    --log /var/log/juicefs.log \
    -f &
  JFSMOUNT_PID=$!

  # Poll until mount point is ready (up to 30s — no China dependency, should be fast)
  TIMEOUT=30
  # ... (same polling logic, shorter timeout)

  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/persistent}"
else
  echo "[entrypoint] JuiceFS not configured, using local workspace"
  export MEIOS_WORKSPACE="${MEIOS_WORKSPACE:-/app/workspace}"
  mkdir -p "$MEIOS_WORKSPACE"
fi

# Security: clear credentials
unset JUICEFS_META_URL AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
```

关键变化：
- `jfsmount mount VOLUME_NAME --token TOKEN --subdir` → `juicefs mount PG_DSN`
- 不需要 `--subdir`（每个用户独立 volume/schema）
- 不需要 `--token`（PG DSN 自带认证）
- S3 凭证通过 `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` env vars 传递（JuiceFS 自动读取）
- timeout 从 60s 降到 30s（不再跨太平洋到 juicefs.com）

验证：部署到 Fly.io，观察 `flyctl logs`，确认 mount 成功且延迟 < 5s。

### Step 7: 数据迁移（现有用户）

现有用户的数据在 JuiceFS Cloud volume 上。需要迁移：

1. 在 openclaw-011 或其他可以 mount 两个 volume 的机器上：
   ```bash
   # Mount 旧 volume
   jfsmount mount meios-persistent /mnt/old --token $OLD_TOKEN --subdir /$USER_ID

   # Mount 新 volume
   juicefs mount "postgres://...?search_path=juicefs_${USER_ID}" /mnt/new

   # Copy
   rsync -av /mnt/old/ /mnt/new/
   ```

2. 现阶段用户很少（2-3人），可以手动迁移。

验证：对比文件数和大小 `du -sh /mnt/old /mnt/new`。

### Step 8: 更新文档和清理

- 更新 `docs/sandbox-startup-optimization.md` 标记迁移完成
- 更新 gateway 的 `.env.example`
- 删除 gateway 对 `JUICEFS_ACCESS_KEY`、`JUICEFS_GCS_KEY_B64` 的所有引用
- 下线 JuiceFS Cloud 订阅

## 实施顺序

```
[x] Step 1 (juicefs.ts)  ← 核心新模块
[x] Step 2 (config.ts)   ← 配置支持
[x] Step 3 (flyio.ts)    ← env var 变更
[x] Step 4 (sandbox.ts)  ← 串联 provisioning
[x] Step 5 (Dockerfile)  ← 镜像更新
[x] Step 6 (entrypoint)  ← sandbox 侧 mount
[x] DB: juicefs_credentials 表已创建
[x] Step 7 (数据迁移)    ← 跳过，旧数据为测试数据无需保留
[x] Step 8 (清理)        ← 完成，JuiceFS Cloud 可下线
[x] 端到端验证通过 (2026-03-24)
```

Step 1-4 是 gateway 侧变更，可以一起开发和测试。
Step 5-6 是 sandbox 侧变更，需要重新 build Docker image。
Step 7 在新代码部署后手动执行。

## Step 9: PG per-user role 隔离（安全修复）

### 问题

`JUICEFS_META_URL` 包含 Supabase master 密码（`postgres` 用户）。
虽然 `search_path=juicefs_{userId}` 设置了默认 schema，但 **不限制访问权限**。

如果 sandbox 中的 agent 或用户获取到该 DSN（通过 `/proc/{pid}/environ` 等），可以：
- 访问**所有用户**的 JuiceFS 元数据 schema
- 访问 `public` schema 中的 `sandboxes`、`juicefs_credentials` 表
- 读取其他用户的 S3 密钥 → **全量数据泄露**

### 修复方案

为每个用户创建独立 PG role，`JUICEFS_META_URL` 使用 per-user role 连接：

```sql
-- provisioning 时（由 gateway 用 master 密码执行）：

-- 1. 创建 per-user role
CREATE ROLE juicefs_user_{id} LOGIN PASSWORD '{random_password}';

-- 2. 创建 schema，owner 设为该 role
CREATE SCHEMA juicefs_{id} AUTHORIZATION juicefs_user_{id};

-- 3. 撤销 public schema 的默认权限
REVOKE ALL ON SCHEMA public FROM juicefs_user_{id};
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM juicefs_user_{id};
```

Sandbox 收到的 DSN 变为：
```
postgres://juicefs_user_{id}:{random_password}@host:5432/postgres?search_path=juicefs_{id}
```

### 修复后的安全模型

```
Gateway (Cloud Run, 可信)
├── Supabase master 密码  ← 只在 gateway 里，sandbox 看不到
├── AWS admin IAM key     ← 只在 gateway 里，用于创建 per-user IAM
└── 负责 provisioning

Sandbox (Fly.io, 不可信 — agent 可执行任意命令)
├── PG: per-user role (只能访问自己的 schema)
├── S3: per-user IAM key (只能访问自己的 prefix)
└── 即使全部泄露，只影响该用户
```

### 改动

- `gateway/src/juicefs.ts`: provisioning 时创建 PG role，DSN 使用 per-user role
- `juicefs_credentials` 表: 新增 `pg_password` 字段存储 per-user role 密码
- Supabase: 需要 `CREATEROLE` 权限（`postgres` 用户默认有）

## 回滚方案

如果新方案有问题：
- JuiceFS Cloud 已下线，不可回滚到 Cloud
- 但可以回退 PG role 隔离：改回 master 密码（降级安全性但保持功能）

## 风险和注意事项

1. **Supabase PG 连接数**: 每个 sandbox mount 会占 1-2 个 PG 连接。当前 max_client_connections=400，足够支撑 100+ 用户。
2. **IAM user 数量限制**: AWS 默认每账号 5000 IAM users，远超需求。
3. **PG schema 数量**: PostgreSQL 无硬性限制。
4. **PG role 数量**: PostgreSQL 无硬性限制。
5. **S3 费用**: $0.023/GB/月 存储 + $0.0004/1000 PUT 请求，初期可忽略。
6. **Gateway 到 Supabase 延迟**: Gateway 在 GCP us-central1，Supabase 在 AWS us-east-1，延迟 ~20ms。provisioning 时一次性开销，不影响运行时。
