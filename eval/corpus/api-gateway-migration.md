# Gateway API Migration Guide

## Overview

This guide covers moving a client between Gateway API versions. It deliberately restates
the numbers that differ between versions, because the most common migration defect is a
client that keeps a v1 constant while pointing at a v2 or v3 route.

The three live surfaces are `/v1/complete`, `/v2/generate` and `/v3/chat`. Any of the three
will reject a body shaped for a different one with `400`, so a silently wrong version is
usually a routing mistake rather than a schema mistake.

## Choosing a Target

New integrations should target v3. Existing v2 integrations should move to v3 only when
they need structured output or the larger window, because v3 changes the rate-limit
accounting in a way that can halve effective throughput for structured-output workloads.

v1 integrations should migrate to v2 at minimum. v1 has no streaming mode, and every
long-answer workload written against v1 pays for it in perceived latency.

## Endpoint Changes

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Path | `/v1/complete` | `/v2/generate` | `/v3/chat` |
| Body | `prompt` | `messages` | `messages` |
| Streaming | none | server-sent events | server-sent events with `phase` |

The version lives in the path on all three. A client that versioned the host instead will
not be routed by the gateway at all, and the failure looks like a DNS failure rather than a
version mismatch.

## Timeout and Retry Changes

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Default timeout | 30000 ms | 60000 ms | 45000 ms |
| Recommended retries | 2 | 5 | 3 |
| Backoff base | 500 ms | 2000 ms | 1000 ms |

A client migrating from v1 to v2 that keeps the v1 backoff of 500 ms will retry far more
aggressively than the version it is talking to expects, which is a common cause of
self-inflicted `429`s during a cutover.

Moving from v2 to v3 in the other direction is the riskier one: v3 has fewer recommended
retries and a lower default timeout, so a client tuned for v2's patience will give up
earlier than it did before.

## Rate Limit Changes

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Default limit | 600 rpm | 3000 rpm | 1200 rpm |
| Burst | 60 | 300 | 120 |

The v3 structured-output path counts as two requests. A v2 workload that produced 1000
structured responses per minute was comfortably inside v2's 3000 rpm budget and is almost
exactly at v3's effective 600-per-minute structured ceiling, so the migration is a
throughput change even though the headline number only fell from 3000 to 1200.

## Context Window Changes

| | v1 | v2 | v3 |
| --- | --- | --- | --- |
| Window | 8192 tokens | 32768 tokens | 65536 tokens |
| Auto-truncation | no | no | no |

None of the three truncates automatically; all three reject an oversized request with `400`.
Clients that relied on an upstream provider's truncation find the migration fails loudly
rather than quietly, which is intentional.

## Checklist

Before cutting over, confirm the path, the body shape, the timeout, the retry count, the
backoff base and the rate-limit budget. Of those six, the two that are missed most often in
practice are the backoff base and the rate-limit budget, because neither produces an error —
they produce a client that is slower or noisier than it was, which is easy to attribute to
the model rather than to the migration.
