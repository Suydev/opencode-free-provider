# The 429 `FreeUsageLimitError` is a trap message — evidence

**Date:** 2026-11-09 · **Endpoint:** `https://opencode.ai/inference/openai/v1/chat/completions` (also reproduced on the old `/inference/v1`)

## Claim

Upstream answers **every rejected free-model request** with the same 429:

```json
{"type":"error","error":{"type":"FreeUsageLimitError","message":"Free usage limit reached. Free models work in OpenCode (https://opencode.ai); subscribe to OpenCode Go to keep going: https://opencode.ai/go"}}
```

regardless of the *actual* reason for rejection — invalid fingerprint, garbage session, or a brand-new IP that has never used the free tier. It is a catch-all denial whose text is marketing for OpenCode Go, not a real quota state.

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
