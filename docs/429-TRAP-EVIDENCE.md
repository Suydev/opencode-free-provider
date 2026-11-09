# The 429 `FreeUsageLimitError` — GATE CRACKED (2026-11-09, later the same day)

**TL;DR:** the 429 is one message masking **two different denials**:

1. **TLS/runtime fingerprint gate** — the request must originate from **Bun** (BoringSSL).
   Node, curl, python, undici — anything with an OpenSSL ClientHello — is rejected with
   this exact 429, `server-timing: gateway;dur=0`, regardless of headers, body, session,
   or IP. **Proven back-to-back:** the byte-identical captured real-client request →
   `200 OK` under Bun, `429` under Node, seconds apart, same IP.
2. **A daily usage pool** on the shared `Bearer public` key that resets at
   **midnight UTC** (5:30 AM IST). When the pool is dry, even a perfect Bun client gets
   this 429. `retry-after` always points at the next midnight UTC (observed 49832s,
   45798s — both landing on 2026-11-10T00:00 UTC). Fresh proxy IPs do NOT help — the
   pool is account-level, not per-IP (tested: direct + 2 fresh premium IPs, all 429).

## The decisive experiment (live MITM capture of the real client)

Official opencode **v2.2.6** (253 MB Bun binary at `~/.opencode/bin/opencode`) was run
inside the PRoot distro (it is glibc-linked; the Termux musl wrapper is what breaks it)
through a local CONNECT-MITM proxy (`HTTPS_PROXY` + `NODE_TLS_REJECT_UNAUTHORIZED=0`,
Bun honors both). Captured wire traffic: `~/opencode-re/captures.jsonl`.

- Real client POSTs to **`https://opencode.ai/inference/openai/v1/chat/completions`**
- Headers: `authorization: Bearer public`, UA `opencode/latest/2.2.6/cli`,
  `x-opencode-client: cli`, `x-opencode-project: <40-hex git hash>` (NOT "global"),
  `x-opencode-session` = `x-opencode-session-id` = one `ses_…` id,
  **plus new v2.2.6 headers**: `x-session-id` + `x-session-affinity` (same `ses_` id)
  and `b3` + `traceparent` (W3C trace context).
  **It does NOT send `x-opencode-request`.**
- Body: `stream: true`, `stream_options: { include_usage: true }`,
  `max_completion_tokens` (not `max_tokens`), tools named
  `shell, glob, grep, read, edit, write, execute, question, skill, subagent, webfetch,
  websearch` — **`shell`, not `bash`** — plus a 9k-char agent system prompt.

Replaying that exact capture:

| Runtime | Result |
|---|---|
| **Bun 1.4.4** | `200 OK` — real GLM-5.3-flash-free SSE chunks (7/7 times across header variants) |
| **Node 22 (OpenSSL)** | `429 FreeUsageLimitError` — byte-identical request |

Header/body ablation on Bun showed headers and body shape are **not** validated:
even `{authorization, content-type, user-agent, x-opencode-session(+id), client,
project}` with no trace headers and no tools returns 200 — while the pool has room.

## Earlier evidence (still valid, now explained)

The probes below were run under Node/curl — i.e. they were all TLS-gate rejections,
which is why they all looked identical:

- Bare curl client, zero fingerprint headers → same 429 (TLS gate, not quota)
- Fresh never-used premium proxy IPs → same 429 (TLS gate; proxies were pointless
  because the client runtime, not the IP, was the discriminator)
- Garbage session id → same 429 (session shape is not validated at all)
- Paid model + free key → 401 AuthError (gateway can be precise when it wants)
- Same construction returned real responses earlier the same day → the difference was
  pool availability + (for the working replica) the Bun runtime
- `server-timing: gateway;dur=0` — static edge rejection, no upstream work

## Practical consequences

1. **The provider must run under Bun.** `bun server.js` (the Docker image already
   does). Under Node every upstream call is trapped.
2. **Proxy rotation cannot fix a 429** — neither gate is IP-based.
3. **The 429 is only "real quota" when the client is Bun** — then it means the shared
   key's daily pool is dry until midnight UTC (5:30 AM IST).
4. Header/body mimicry beyond the basics is unnecessary — runtime is everything.

## Evidence

### E1 — A bare curl client gets the *quota* message, not a fingerprint rejection

Sent with `user-agent: curl/8.5.0`, **zero** `x-opencode-*` headers, no session id:

```
[direct+bare-client(TRAP-CONTROL)] status=429 ms=1167
body= {"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. …"}}
```

If the quota were real, a bare client must fail **fingerprint validation first**. The gateway used to answer exactly that with `403 FreeTierError: OpenCode's free tier can only be used from within OpenCode`. That 403 branch is gone — a client with *no fingerprint at all* is told its "free usage limit" was reached, which it cannot even have (it never authenticated a session).

### E2 — Fresh, never-used IPs get the identical 429

Three unused premium proxies (proxyscrape list, distinct exit IPs), each with a **valid, correctly-shaped fingerprint** (`ses_` + descending id, counter ≤ 63, full header set):

```
[proxy+valid-fp] 216.26.250.142 status=429 body= FreeUsageLimitError …
[proxy+valid-fp] 45.3.55.143    status=429 body= FreeUsageLimitError …
[proxy+valid-fp] 216.26.235.115 status=429 body= FreeUsageLimitError …
```

A real per-IP quota cannot be "reached" on an IP that has never made a request. Same message, byte-for-byte.

### E3 — A garbage session id gets the same 429

```
session=ses_garbagegarbage0000 → 429 FreeUsageLimitError
```

No shape validation, no counter check, no error differentiating an absurd id from a real one. The gate is not even looking at the session anymore.

### E4 — The gateway *can* return precise errors; it just doesn't for free models

Paid model with the same free `Bearer public` key:

```
claude-sonnet-4-5 → 401 {"type":"error","error":{"type":"AuthError","message":"Missing API key."}}
```

So the rejection plumbing works and can say *why* (auth). The free-model endpoint simply never says why — it always says "free usage limit".

### E5 — The same construction returned a real response hours earlier, same IP

`~/opencode-re/PROVIDER_REPORT.md` (this machine, this session):

> - Model: `glm-5.3-flash-free`
> - Prompt: `Reply with exactly REPLICA-OK`
> - Response: `REPLICA-OK`

Same IP, same fingerprint generator, real GLM output. Nothing about the client changed since; the server behavior did. Our fingerprint was provably sufficient — so the current 429 cannot be "your fingerprint is bad" *or* "your IP is exhausted" (E2).

### E6 — Response headers: the gateway spent 0 ms deciding

```
status: 429
server-timing: gateway;dur=0, total;dur=0
retry-after: 49832
x-opencode-log-id: 01a1bfc8-c52c-7070-be67-09c3320abfcd
cf-placement: remote-IAD
```

- `gateway;dur=0` — no upstream model work, no quota accounting; a static edge rejection.
- `retry-after: 49832` (~13.8 h) — a boilerplate "come back tomorrow" regardless of actual usage.

## Interpretation

OpenCode changed the free-tier gate. All free-model traffic from anything that is not
recognized as the real current client is denied at the edge with the Go-subscription
message. The old differentiated errors (`403 FreeTierError`, `426 Upgrade Required`,
shape-validation failures) all funnel into the same 429. **`429 FreeUsageLimitError` ≡
"this request was rejected", nothing more.**

## Consequences for this provider

1. **Proxy rotation cannot fix a 429** — there is no quota to rotate away from (E2).
2. **The fingerprint we replicate (session-id algorithm, header set, UA) is shape-valid
   but no longer *sufficient*** — upstream added a check we don't satisfy yet. Next step:
   capture what the *current* real opencode client sends (the earlier Bun-FS extraction in
   `~/opencode-re/` has the embedded client code; re-diff it against what we replay).
3. Any logic that treats this 429 as "quota exhausted, cool down 14 h" (the old
   fail-fast path) is reacting to a fake signal.

## Reproduce

```bash
node -e "
(async () => {
  const m = await import('./src/fingerprint.js')
  const res = await fetch('https://opencode.ai/inference/openai/v1/chat/completions', {
    method: 'POST',
    headers: { ...m.buildFingerprintHeaders(m.newSessionId()), Authorization: 'Bearer public' },
    body: JSON.stringify({ model: 'glm-5.3-flash-free', stream: true, max_tokens: 16,
      messages: [{ role: 'user', content: 'Say OK' }],
      tools: ['bash','glob','grep','read'].map(n => ({ type: 'function', function: { name: n, arguments: '{}' } })) }),
  })
  console.log(res.status, await res.text())
})()"
```

Change the session to `ses_garbagegarbage0000`, drop the `x-opencode-*` headers, or run
through a fresh proxy — the body is the same every time.
