# Gateway API v1 Reference

## Overview

The v1 Gateway API is the first generally available surface for text completion. It
accepts a prompt and returns a completion, with no notion of roles, tools or streaming
frames beyond newline-delimited chunks. Clients are expected to be long-lived processes
that hold a single connection open and issue many requests over it.

v1 is closed to new features. It receives security fixes only, and the deprecation notice
on the v1 endpoint names v2 as the supported successor.

## Endpoint

Requests go to the `/v1/complete` path. The path is versioned rather than the host, so a
client that hardcodes the host will silently keep talking to v1 after an upgrade. The
request body carries `prompt`, `max_tokens` and an optional `stop` array; there is no
`system` field, and a system instruction has to be concatenated into the prompt.

Responses are returned as a single JSON object. v1 has no streaming mode, which is the
change most often cited in migration discussions.

## Timeouts and Retry

The default request timeout is **30000 milliseconds**. A request that has not produced any
output within that window is cancelled by the gateway, not by the client, and the client
sees a `504` with the body `{"error":"upstream_timeout"}`.

The recommended retry count is **2**. The gateway does not retry on the client's behalf, so
this is a client-side contract rather than an enforced limit. The recommended backoff base
is **500 milliseconds**, doubled on each subsequent attempt, which produces waits of 500 ms
then 1000 ms for the two allowed retries. Jitter is not required by v1 but is recommended.

Retrying a timed-out request is safe because v1 has no server-side session state. Retrying
a request that failed with `429` is not useful unless the `Retry-After` header is honoured
first.

## Rate Limits

The default rate limit is **600 requests per minute**, counted per API key rather than per
connection. Bursts of up to 60 requests may be issued within any one-second window before
the limiter engages, so a short burst is allowed even when the per-minute budget is nearly
spent.

Exceeding the limit returns `429` with a `Retry-After` header in seconds. The limiter
counts a request when the body has been fully received, not when the response is produced,
which means a slow upstream does not consume budget twice.

## Context Window

The maximum context window is **8192 tokens**, counting the prompt and the completion
together. A request whose prompt alone exceeds the window is rejected with `400` rather
than truncated, because silent truncation was found to produce worse answers than a
visible failure.

Token counting uses the same tokenizer as the model, so an approximation by character
count will disagree near the boundary. The gateway exposes a `/v1/tokenize` helper for
clients that want an exact count before sending.
