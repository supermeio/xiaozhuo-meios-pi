# Streaming Protocol — meios Gateway

## 设计决策

借鉴 [Vercel AI SDK Stream Protocol](https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol) 的事件设计，使用标准 SSE（Server-Sent Events）。

**为什么不选其他方案：**
- Claude API 事件模型过于复杂（content_block index 跟踪），meio 场景不需要
- OpenAI 格式太简单（只有 chunk + DONE），没有 tool 状态
- Vercel AI SDK 事件类型直觉明了，专为前端设计，复杂度适中
- 长轮询（openclaw ios-channel 模式）适合异步消息，不适合实时流

## 协议

### 请求

```
POST /chat
Accept: text/event-stream        ← 触发 SSE streaming
Content-Type: application/json

{"message": "...", "sessionId": "s-..."}
```

不带 `Accept: text/event-stream` 时，行为不变（返回完整 JSON），保持向后兼容。

### 响应

标准 SSE 格式：`data: {json}\n\n`，以 `data: [DONE]\n\n` 结束。

### 事件类型

| type | 数据 | 说明 |
|------|------|------|
| `session` | `{sessionId}` | 首个事件，告知 session ID |
| `text-delta` | `{delta}` | 文字增量，逐字到达 |
| `tool-start` | `{toolName, toolCallId}` | 工具开始执行（如 generate_image） |
| `tool-end` | `{toolName, toolCallId, isError}` | 工具执行完成 |
| `done` | `{reply, content[]}` | 最终内容（含解析后的图片 blocks） |
| `error` | `{message}` | 错误 |

### 完整事件流示例

```
data: {"type":"session","sessionId":"s-1773474799061-i4duxq"}

data: {"type":"text-delta","delta":"好的，"}

data: {"type":"text-delta","delta":"我来帮你生成一张白色波斯小猫的图片！"}

data: {"type":"tool-start","toolName":"generate_image","toolCallId":"toolu_abc123"}

data: {"type":"tool-end","toolName":"generate_image","toolCallId":"toolu_abc123","isError":false}

data: {"type":"text-delta","delta":"图片已生成完成！保存到了 outfits/white-persian-kitten.png"}

data: {"type":"done","reply":"好的，我来帮你...","content":[{"type":"text","text":"..."},{"type":"image","url":"/files/outfits/white-persian-kitten.png","imageId":"img-..."}]}

data: [DONE]
```

### iOS 端行为

1. 收到 `session` → 记录 sessionId
2. 收到 `text-delta` → 实时追加文字到 assistant 消息气泡
3. 收到 `tool-start` → 显示工具状态条（"生成图片中..."）
4. 收到 `tool-end` → 状态条变为完成 ✓
5. 收到 `done` → 用最终 content blocks 替换（含图片），标记消息完成
6. 收到 `[DONE]` → 关闭连接

### curl 测试

```bash
curl -N -X POST http://localhost:18800/chat \
  -H "Content-Type: application/json" \
  -H "Accept: text/event-stream" \
  -d '{"message":"hello"}'
```
