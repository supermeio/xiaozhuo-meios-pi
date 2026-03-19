# CLAUDE.md

## Lessons Learned

### Debugging: don't blame external systems without evidence

When something doesn't work, **assume it's our own code first** — especially when the external system (Cloud Run, Cloudflare, Google frontend, third-party SDK) is widely used. If there were an obvious bug, thousands of other users would have reported it already.

**Case study — SSE streaming (2026-03):**
We spent hours blaming Cloud Run response buffering, then Cloudflare Proxied mode, then Google domain mapping frontend (`ghs.googlehosted.com`) for breaking SSE streaming. Each wrong attribution led to unnecessary workarounds (direct Cloud Run URL, researching Load Balancer migration, attempting HTTP/2 changes). The actual root cause was our own proxy code using `ReadableStream`'s `pull()` mode instead of `start()` mode — a one-line fix.

**How to apply:**
1. **Isolate first**: write a minimal reproduction that eliminates variables (e.g., a `/sse-test` endpoint that generates SSE directly without the proxy layer)
2. **Control experiment**: test the working path and broken path side by side, identify the single differing variable
3. **Evidence before conclusions**: saying "system X has a bug" requires documentation, other user reports, and isolated proof — not speculation
4. **Respect widely-used systems**: Cloud Run / Cloudflare / GCP are battle-tested at scale. No reports of the issue = almost certainly our problem
5. **Stay humble**: we are newcomers and learners. Rigorous curiosity over assumptions.
