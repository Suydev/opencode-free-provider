# OpenCode session-id generation — the algorithm and the correct way to mint ids

**Date:** 2026-11-09 · **Sources:** static extraction of the real opencode binary
(`~/opencode-re/DEEP_ANALYSIS.md`), live ablation against the free-tier gate, and the
pure-JS implementation in [`src/fingerprint.js`](../src/fingerprint.js).

## 1. Format

A real id is `prefix` + 26 chars:

```
ses_e4030503affezBG60urR55STTe
^^^ ^^^^^^^^^^^^ ^^^^^^^^^^^^^^
 |  |            |
 |  |            +-- 14 random base62 chars  (charset 0-9A-Za-z)
 |  +--------------- 12 lowercase hex chars  (48-bit value, big-endian)
 +------------------ prefix: `ses_` (session) / `msg_` (message) / others (`prt_`, …)
```

No checksum, no signature. The server validates **shape only**:
length 26 after the prefix, first 12 chars lowercase hex, last 14 chars base62.

## 2. The algorithm (opencode `packages/schema/src/identifier.ts`)

Two flavors share one counter:

- **descending** (sessions: `ses_`) — the 48-bit value is **bitwise-inverted**,
  so ids sort newest-first.
- **ascending** (messages: `msg_`) — no inversion; sorts oldest-first.

Per call:

```
counter++                                        # per-millisecond, resets each new ms
current = BigInt(Date.now()) * 0x1000n + BigInt(counter)   # 0x1000 = 4096
value   = descending ? ~current : current        # keep 48 bits
hex     = value.toString(16).padStart(12, '0')   # lowercase, exactly 12 chars
tail    = 14 × random base62 char
id      = prefix + hex + tail
```

The low 12 bits of `current` are the counter field itself, so after inversion:

```
low12(value) = 0xfff - counter
```

## 3. Worked numeric example

`Date.now() = 1794219421633`:

| counter | `current = ts*4096+counter` | `~current & (2^48-1)` (hex, 12 chars) | low 12 bits |
|--------:|----------------------------:|---------------------------------------|-------------|
| 1       | 7349122751008769            | `e4030503effe`                        | `0xffe`     |
| 2       | 7349122751008770            | `e4030503effd`                        | `0xffd`     |
| 64      | 7349122751008832            | `e4030503efbf`                        | `0xfbf`     |

Full id for counter=1: `ses_e4030503effe` + 14 base62 chars, e.g.
`ses_e4030503effezBG60urR55STTe`.

## 4. What the gate actually checked (live ablation, 2026-04)

| Field | Verdict |
|---|---|
| counter | **must be ≤ 63** → `low12 ≥ 0xfc0`. counter 0–63 → pass; 64–4095 → reject. |
| timestamp magnitude / recency | NOT validated (old timestamps pass) |
| the upper 36 bits | NOT validated |
| tail charset | NOT validated — only the **length** (exactly 14) |
| cryptographic checksum | none exists |

So emitting opencode's real algorithm with `Date.now()` and a small counter always
produces a gate-valid id — which is exactly what `src/fingerprint.js` does, including
rollover: if more than 63 ids are minted in one millisecond, the clock is advanced by
1 ms instead of emitting a rejected counter.

## 5. Correct methods (do this)

The only correct way is to **reimplement opencode's own algorithm** — pure JS, BigInt,
no CLI, no MITM. Reference implementation: [`src/fingerprint.js`](../src/fingerprint.js).

```js
import { randomBytes } from 'node:crypto'

const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const MASK_48 = (1n << 48n) - 1n
const MAX_COUNTER = 63

let lastTimestamp = 0, counter = 0

export function encodeIdentifier(timestamp = Date.now(), { descending = true } = {}) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  counter++
  if (counter > MAX_COUNTER) { lastTimestamp += 1; counter = 1 }   // never emit counter > 63
  const current = BigInt(lastTimestamp) * 0x1000n + BigInt(counter)
  const value = (descending ? ~current : current) & MASK_48
  return value.toString(16).padStart(12, '0')
    + Array.from(randomBytes(14), b => CHARS[b % 62]).join('')
}

export const newSessionId = () => `ses_${encodeIdentifier(Date.now())}`            // descending
export const newMessageId = () => `msg_${encodeIdentifier(Date.now(), { descending: false })}`
```

Header wiring (must match the real client):

- `x-opencode-session` = `x-opencode-session-id` = one fresh `ses_…` id — **a mismatch
  between the two is rejected**.
- `x-opencode-request` = a fresh `msg_…` id (ascending).
- One id per request under `per-request` mode; a sticky session is allowed but must be
  minted by the same algorithm.

## 6. Common mistakes (each produced plausible-but-wrong ids)

1. **Guessing the layout instead of reading it.** Four encoder bugs came from inventing
   the bit layout; every one produced *plausible bytes*. Read `identifier.ts` first.
2. **Using `Math.random()` for the tail** — fine for charset, but must be exactly 14
   chars; and the hex part is not random at all.
3. **Forgetting the 48-bit mask.** Without `& (2^48-1)`, `~current` yields a negative
   BigInt and `.toString(16)` emits a `-` sign.
4. **Counter drift.** `0xfff - counter` means *large* counters change the high bits' low
   nibble too — a counter > 63 fails the gate even though the string "looks right".
5. **Duplicated literals across files.** Charset and mask must be shared constants, not
   re-typed per file — they drifted once and silently halved every value.
6. **Treating ascending and descending as different counters.** opencode shares one
   per-ms counter across both; mirroring that exactly keeps ids indistinguishable.

## 7. Research provenance

- **Static:** `ID.create` verified in the extracted Bun payload
  (`chunk-d8xgva6m.js` / `chunk-wxdgy02y.js`): 6 bytes of `(Date.now()*4096+counter)`
  as hex, then 14 chars via `crypto.getRandomValues` from a 62-char alphabet.
  UA template `opencode/${channel}/${packagedVersion}/cli` in `chunk-4f5needp.js`
  (app reports **v2.2.6** — `2.0.22` was stale and is now overridable via `OPENCODE_UA`).
- **Dynamic:** live ablation on the free-tier gate (counter bound, non-validated fields)
  — table in §4.
- **Implementation + tests:** `src/fingerprint.js`, exercised by the full suite
  (`node --test test/*.test.js`, 90 passing).

## 8. Caveat (2026-11-09)

The gate began answering **all** rejected free-model requests with the same
`429 FreeUsageLimitError` — see [`429-TRAP-EVIDENCE.md`](429-TRAP-EVIDENCE.md). The
session-id algorithm above is still what the real client emits and remains a necessary
condition; upstream has however added a further gate check that is not (yet) identified,
so a correctly-minted id is necessary but no longer by itself sufficient.
