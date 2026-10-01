# Gateway API v2 Reference

## Overview

The v2 Gateway API replaces the single-prompt completion surface with a message list. It
introduces roles, a real streaming mode and server-side sessions, and it is the surface the
deprecation notice on v1 points at. v2 is feature-frozen: it receives correctness and
security fixes, and v3 is the current recommended target for new integrations.

The message list is the change that forces most migrations. A v1 prompt with a concatenated
system instruction has to be split into a `system` message and a `user` message, and clients
that relied on concatenation usually find their prompts measurably worse until they split
them.

## Endpoint

Requests go to the `/v2/generate` path. Unlike v1, the version is part of the route and
the gateway rejects a v1-shaped body with `400` and a pointer at the migration guide. The
request body carries `messages`, `max_tokens`, `stream` and an optional `tools` array.

Streaming is enabled per request with `stream: true`, and frames are server-sent events
rather than newline-delimited JSON. Frames carry a monotonically increasing `index`; a
client that reconnects mid-stream must resume from the last index it acknowledged.

## Timeouts and Retry

The default request timeout is **60000 milliseconds**, doubled from v1 because v2 sessions
are allowed to think for longer before the first token. The timeout covers the whole turn,
not the gap between frames.

The recommended retry count is **5**, with a recommended backoff base of **2000
milliseconds** and full jitter. The higher retry count exists because v2 introduced
server-side sessions, and a retried request may attach to the same session rather than
starting a new one — retrying is therefore usually cheaper than it was in v1.

A timeout is reported as `504` with `{"error":"upstream_timeout"}` exactly as in v1, so a
client that only inspects that field cannot tell which version produced it.

## Rate Limits

The default rate limit is **3000 requests per minute**, counted per API key. Sessions are
counted separately: opening a session costs one request, and each subsequent turn on that
session costs one request, so a long conversation consumes budget linearly.

Bursts of up to 300 requests may be issued within one second. When a session is already
open, the limiter applies the request to the session's own budget first, which means a
bursty client with many open sessions can exhaust the per-minute budget much faster than
the raw request count suggests.

## Context Window

The maximum context window is **32768 tokens**. v2 grew the window partly to make room for
tool definitions, which are counted in the same budget as messages. A request that exceeds
the window is rejected with `400`; v2 does not offer automatic truncation either.

Because tools are counted, a request with a large tool schema can exceed the window even
when the conversation itself is short. The gateway reports the split between message tokens
and tool tokens in the `usage` block of every response so a client can see which side grew.

## Sessions

A session is created implicitly by the first request that omits `session_id`. Sessions
expire after 30 minutes of inactivity. A request that names an expired session is not an
error: the gateway starts a new one and reports the new id, a behaviour that has surprised
several integrators into thinking their retry had lost context.
