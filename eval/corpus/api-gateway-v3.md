# Gateway API v3 Reference

## Overview

The v3 Gateway API is the current recommended surface. It keeps the message list and
streaming model introduced in v2 and adds structured output, explicit reasoning budgets and
a per-request deadline. v1 and v2 remain available but receive fixes only.

v3 is not wire-compatible with v2. A v2 body sent to the v3 route is rejected with `400`
and a link to the migration guide, exactly as a v1 body is rejected by v2.

## Endpoint

Requests go to the `/v3/chat` path. The body carries `messages`, `max_tokens`, `stream`,
an optional `response_format` describing structured output, and an optional `deadline_ms`
that overrides the default timeout for one request.

Streaming frames are server-sent events and now carry both an `index` and a `phase`, so a
client can distinguish reasoning frames from answer frames without inspecting the text.
Structured output is delivered as a single final frame; partial structured output is not
emitted, because a half-parsed object was found to be worse than no object.

## Timeouts and Retry

The default request timeout is **45000 milliseconds**, between v1's 30 s and v2's 60 s,
chosen after measuring that the median v3 turn finishes in about 11 s while the long tail
benefits from more room than v1 gave.

The recommended retry count is **3**, with a backoff base of **1000 milliseconds** and full
jitter. v3 adds `deadline_ms`, and a request that carries it uses that value instead of the
default: a client that sets `deadline_ms` to 10000 is not retried by the gateway past the
client's own deadline, which makes the two settings interact in a way v1 and v2 had no
equivalent for.

## Rate Limits

The default rate limit is **1200 requests per minute**. Structured-output requests are
counted as two requests, because the gateway runs a validation pass over the produced object
before returning it; a client that migrates a high-volume v2 workload to structured output
can therefore exhaust its budget at half the expected request count.

Bursts of up to 120 requests may be issued within one second. The limiter applies reasoning
tokens against a separate budget from requests, so a client with long reasoning turns can
hit the token budget before the request budget.

## Context Window

The maximum context window is **65536 tokens**, the largest of the three versions, and the
only one where tool schemas, reasoning tokens and messages are reported as three separate
line items in `usage` rather than folded together.

A request that exceeds the window is rejected with `400`. v3 does not truncate
automatically, but it does report how many tokens the request would need, which makes a
programmatic retry at a smaller size possible without re-tokenising the input.

## Structured Output

`response_format` accepts a JSON schema and a strictness flag. Strict mode is slower but
guarantees the object validates against the schema. Non-strict mode is the default and can
return an object that parses but does not match, which the gateway flags in a
`validation_errors` array rather than failing the request.
