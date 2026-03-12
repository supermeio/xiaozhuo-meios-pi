# Model Selection

> Updated: 2026-03-12

## Current Default: Kimi K2.5

meios sandbox 的默认模型是 **Kimi K2.5**（Moonshot），通过 LiteLLM Proxy 以 OpenAI 格式调用。

## 背景：为什么需要 LiteLLM

meios 之前有 ~500 行自写 proxy 代码处理 token 验证、rate limiting、budget、多 provider 路由、usage tracking、pricing。这些需求并不特殊，用 [LiteLLM](https://github.com/BerriAI/litellm) 替代后代码量降到 ~100 行薄 relay。

LiteLLM 的核心价值：
- **Virtual key** — 每个 sandbox 一个 key，自带 rpm limit、月预算、自动重置
- **多 provider 路由** — 一个 OpenAI 格式入口，后端路由到 Gemini / Anthropic / OpenAI / Moonshot
- **Usage tracking** — Dashboard 可查每个 key/model 的用量和花费
- **格式翻译** — 把 OpenAI `/chat/completions` 翻译成各 provider 原生格式

## LiteLLM 的两种接口

| 接口 | 路径 | 格式 | 翻译 |
|------|------|------|------|
| OpenAI compatible | `/chat/completions` | OpenAI format | LiteLLM 翻译为各 provider 原生格式 |
| Anthropic pass-through | `/anthropic/v1/messages` | Anthropic native | 零翻译，直接透传 |

**OpenAI 格式（主路径）：** 所有非 Anthropic 模型走这条路。LiteLLM 负责 OpenAI ↔ provider 的格式转换。对于原生就兼容 OpenAI 的 provider（如 Moonshot/Kimi），翻译是无损的。

**Anthropic 透传：** Claude 模型走这条路。保留完整的 Anthropic 原生格式（tool_use blocks、extended thinking），零翻译零损耗。这是 LiteLLM 官方支持的路径，不是 hack。

## 候选模型对比

### 价格

| 模型 | Input $/M tokens | Output $/M tokens | 备注 |
|------|------------------|-------------------|------|
| Gemini 3.1 Flash Lite | $0.25 | $1.50 | Google，最便宜 |
| Kimi K2.5 | $0.60 | $3.00 | Moonshot，cache hit 仅 $0.10/M |
| Claude Haiku 4.5 | $1.00 | $5.00 | Anthropic，走 pass-through |
| GPT-4.1 mini | $0.40 | $1.60 | OpenAI |
| GPT-4.1 nano | $0.10 | $0.40 | OpenAI，最便宜但能力有限 |

在 $5/月免费预算下，Kimi K2.5 足够日常使用（几万 tokens/月花不到 $1）。

### Tool Calling 实测（2026-03-12）

通过 LiteLLM `/chat/completions` 测试多轮 tool calling（模拟 pi-agent 的 read_file → write_file → read_file 验证流程）：

**Gemini 3.1 Flash Lite — 失败**
```
Turn 1: read_file("/tmp/config.json")     ✓ 正确
Turn 2: run_command("ls -l /tmp/...")      ✗ 不应该，应该 write
Turn 3: run_command("cat /tmp/...")        ✗ 循环
Turn 4: read_file("/tmp/config.json")      ✗ 重复读
Turn 5: run_command("cat /tmp/...")        ✗ 仍在循环
→ 5 轮后未完成任务
```

已知问题：LiteLLM GitHub Issue [#17949](https://github.com/BerriAI/litellm/issues/17949) — Gemini 多轮 function calling 在 thinking model 下存在 part count mismatch。OpenAI 格式翻译会丢失 Gemini 特有的 `thought_signature`，导致后续轮次行为异常。

**Kimi K2.5 — 成功**
```
Turn 1: read_file("/tmp/config.json")      ✓
Turn 2: write_file(path, updated content)  ✓
Turn 3: read_file("/tmp/config.json")      ✓ 验证
Turn 4: 文本总结                            ✓ finish_reason=stop
→ 4 轮完美完成
```

注意：Kimi K2.5 是 thinking model，LiteLLM 要求多轮对话中回传 assistant 消息时必须包含 `reasoning_content` 字段，否则返回 400。pi-ai SDK 的 OpenAI provider 已正确处理此字段。

### 决策

| 维度 | Gemini 3.1 Flash Lite | Kimi K2.5 |
|------|----------------------|-----------|
| 价格 | $0.25 / $1.50 | $0.60 / $3.00 |
| Tool calling 质量 | 多轮循环，不可用 | 完美 |
| 格式兼容性 | 需 OpenAI↔Gemini 翻译（有损） | 原生 OpenAI 兼容（无损） |
| Thinking | 支持但 signature 在翻译中丢失 | 支持，reasoning_content 正确传递 |

**结论：选 Kimi K2.5。** 价格 ~2x 但在预算内无影响，tool calling 可靠性是刚需。Gemini 的格式翻译问题可能随 LiteLLM 更新修复，届时可重新评估。

## 其他模型用途

| 模型 | 用途 | 接口 |
|------|------|------|
| Kimi K2.5 | 默认对话 + tool calling | OpenAI format |
| Claude Haiku 4.5 | Coding 任务（高质量 tool use） | Anthropic pass-through |
| Claude Opus 4.6 | 复杂推理 / 代码审查 | Anthropic pass-through |
| Gemini 2.5 Flash | 备选（待 LiteLLM 修复后重新评估） | OpenAI format |

## 如何切换默认模型

`server/src/gateway.ts` 第 109 行：

```typescript
const model = getModel('openai', 'kimi-k2.5')
```

改为其他 `litellm/config.yaml` 中配置的模型名即可。所有模型名必须与 LiteLLM config 中的 `model_name` 一致。

## 价格来源

- Gemini: [Google AI Pricing](https://ai.google.dev/gemini-api/docs/pricing)
- Kimi: [Moonshot Platform Pricing](https://platform.moonshot.ai/docs/pricing/chat)
- Claude: [Anthropic Pricing](https://www.anthropic.com/pricing)
- OpenAI: [OpenAI Pricing](https://openai.com/api/pricing)
