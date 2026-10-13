// src/fingerprint.js
//
// Dynamic OpenCode fingerprint generator.
//
// WHY THIS EXISTS
// ---------------
// OpenCode's free tier (opencode.ai/zen/v1) enforces a client-fingerprint gate.
// The gate requires:
//   - User-Agent  : `opencode/<ver>/<cli|...>`
//   - x-opencode-session : a session id of a SPECIFIC, non-trivial shape.
//     It looks like `ses_` + 26 chars of mixed-case alphanumerics. It is NOT a
//     simple random hex string — the server validates its structure/checksum,
//     so it CANNOT be faked by the proxy. The only reliable source of a valid
//     id is the real `opencode` binary itself.
//
// This module therefore spawns the real `opencode` CLI, points it at a local
// MITM proxy via HTTPS_PROXY, and intercepts the chat/completions request
// opencode makes. The real fingerprint headers (User-Agent, x-opencode-session,
// x-opencode-session-id, x-opencode-client, x-opencode-project, …) are captured
// and cached for reuse.
//
// USAGE
// -----
//   import { getFingerprint } from './fingerprint.js'
//   const fp = await getFingerprint()   // → { headers: {...}, session, source }
//   // fp.headers is merged into every upstream request.
//
// Fallbacks: if `opencode` cannot be spawned (not installed, network sandbox),
// or OpenSSL/TLS interception fails, the module falls back to a static,
// last-known-good capture so the proxy still boots. Set
// OPENCODE_FP_DISABLE=1 to skip spawning entirely.

import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ZEN_HOST = 'opencode.ai'
const MODELS_HOST = 'models.opencode.ai'
const CAPTURE_TIMEOUT_MS = Number(process.env.OPENCODE_FP_TIMEOUT_MS) || 15000
const CACHE_TTL_MS = Number(process.env.OPENCODE_FP_TTL_MS) || 30 * 60 * 1000 // 30 min

// ---------------------------------------------------------------------------
// Self-signed CA for the MITM proxy. Generated once (in-memory, on disk
// temporarily). The spawned opencode runs with NODE_TLS_REJECT_UNAUTHORIZED=0
// so it trusts our cert. (opencode is a Bun binary; this env var is honored by
// its fetch.) We mint the CA with OpenSSL, present on any box with opencode.
// ---------------------------------------------------------------------------
function generateCa() {
  try {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ocfp-'))
    const keyPath = path.join(tmp, 'ca.key')
    const crtPath = path.join(tmp, 'ca.crt')
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyPath, '-out', crtPath, '-days', '2',
      '-subj', '/CN=opencode-fp-mitm',
    ], { stdio: 'ignore', timeout: 8000 })
    if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
      return { key: fs.readFileSync(keyPath), cert: fs.readFileSync(crtPath), tmp }
    }
  } catch { /* fall through */ }
  return null
}

// ---------------------------------------------------------------------------
// MITM proxy. For CONNECT to opencode.ai we terminate TLS with our CA cert,
// sniff the plaintext request to capture the real fingerprint headers, and
// faithfully relay the bytes (headers + body) to the real server so opencode's
// own request completes (and so the captured session id is the genuine one).
//
// The relay is byte-faithful: the first client→server chunk is parsed for
// headers only after a copy has been queued to the real upstream; subsequent
// body chunks are forwarded verbatim. This avoids dropping body bytes when the
// header block and body arrive in separate TLS records (the bug that produced
// unusable session ids before).
//
// Returns { server, port, captureState }. captureState.captured becomes true
// once the fingerprint is intercepted.
// ---------------------------------------------------------------------------
function startMitm(ca, onCapture) {
  const captureState = { captured: false }
  return new Promise((resolve) => {
    const server = http.createServer()
    server.on('connect', (req, clientSocket, head) => {
      const [host, portStr] = (req.url || '').split(':')
      const port = Number(portStr) || 443
      const isZen = host.includes(ZEN_HOST) || host.includes(MODELS_HOST)
      if (!isZen) {
        // transparent passthrough (e.g. localhost standalone server)
        const s = net.connect(port, host, () => {
          clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
          if (head.length) s.write(head)
          s.pipe(clientSocket)
          clientSocket.pipe(s)
        })
        s.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => s.destroy())
        return
      }
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const ctls = new tls.TLSSocket(clientSocket, {
        isServer: true,
        SNICallback: (sni, cb) => cb(null, tls.createSecureContext({ key: ca.key, cert: ca.cert })),
      })
      let real = null
      let captured = false
      ctls.on('data', (clear) => {
        // Forward everything to the real server; create the upstream tunnel
        // lazily on the first chunk.
        if (!real) {
          real = tls.connect(port, host, { servername: host }, () => real.write(clear))
          real.on('data', (d) => ctls.write(d))
          real.on('error', () => clientSocket.destroy())
          real.on('close', () => ctls.end())
        } else {
          real.write(clear)
        }
        if (!captured) {
          const txt = clear.toString('latin1')
          const i = txt.indexOf('\r\n\r\n')
          if (i < 0) return // header block not complete yet; body will arrive later
          const headStr = txt.slice(0, i)
          const parts = headStr.split('\r\n')
          const [method, p] = parts[0].split(' ')
          const hdrs = {}
          parts.slice(1).forEach((l) => {
            const c = l.indexOf(':')
            if (c > 0) hdrs[l.slice(0, c).toLowerCase()] = l.slice(c + 1).trim()
          })
          if (p && p.includes('/zen/v1/chat/completions')) {
            captured = true
            captureState.captured = true
            onCapture({ method, path: p, headers: hdrs })
          }
        }
      })
      ctls.on('error', () => clientSocket.destroy())
    })
    server.on('error', () => { /* ignore */ })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      resolve({ server, port: addr.port, captureState })
    })
  })
}

// ---------------------------------------------------------------------------
// Spawn opencode; it will (via HTTPS_PROXY) send its real zen request through
// our MITM. We resolve as soon as the fingerprint is captured.
// ---------------------------------------------------------------------------
async function captureFromOpencode(proxyPort, captureState) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ocfp-cfg-'))
  // Clone env, then force opencode's traffic through our MITM and neutralize any
  // other proxy vars that could divert the request away from it.
  const env = { ...process.env }
  delete env.ALL_PROXY
  delete env.all_proxy
  delete env.NODE_EXTRA_CA_CERTS
  env.OPENCODE_CONFIG_DIR = tmpDir
  env.HOME = tmpDir
  env.OPENCODE_API_KEY = ''
  env.HTTPS_PROXY = `http://127.0.0.1:${proxyPort}`
  env.HTTP_PROXY = `http://127.0.0.1:${proxyPort}`
  env.NO_PROXY = '127.0.0.1,localhost'
  env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
  const proc = spawn('opencode', ['run', 'say hi', '--standalone', '-m', 'opencode/big-pickle'], {
    env,
    stdio: ['ignore', 'ignore', 'ignore'],
  })
  const ok = await new Promise((resolve) => {
    const iv = setInterval(() => { if (captureState.captured) { clearInterval(iv); resolve(true) } }, 50)
    setTimeout(() => { clearInterval(iv); resolve(false) }, CAPTURE_TIMEOUT_MS)
  })
  try { proc.kill('SIGKILL') } catch { /* ignore */ }
  fs.rmSync(tmpDir, { recursive: true, force: true })
  return ok
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
let _cache = null
let _cacheAt = 0

// Last-known-good fingerprint (captured from opencode v2.0.22). Used as a
// fallback when the live `opencode` command cannot be spawned. The session id
// here is a real one emitted by opencode; if the server later rejects it, the
// operator can force a refresh (OPENCODE_FP_DISABLE unset + fresh process, or
// call getFingerprint({ force: true }) from a context where opencode works).
const FALLBACK_FP = {
  headers: {
    'content-type': 'application/json',
    authorization: 'Bearer public',
    'user-agent': 'opencode/latest/2.0.22/cli',
    'x-opencode-client': 'cli',
    'x-opencode-project': 'global',
    'x-opencode-session': 'ses_ecc24eda9ffeOJLs4VeYcatc3g',
    'x-opencode-session-id': 'ses_ecc24eda9ffeOJLs4VeYcatc3g',
    'x-session-affinity': 'ses_ecc24eda9ffeOJLs4VeYcatc3g',
    'x-session-id': 'ses_ecc24eda9ffeOJLs4VeYcatc3g',
  },
  session: 'ses_ecc24eda9ffeOJLs4VeYcatc3g',
  source: 'fallback',
}

function buildFingerprintFromHeaders(h) {
  const session = h['x-opencode-session'] || h['x-session-id'] || ''
  return {
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer public',
      'user-agent': h['user-agent'],
      'x-opencode-client': h['x-opencode-client'] || 'cli',
      'x-opencode-project': h['x-opencode-project'] || 'global',
      'x-opencode-session': session,
      'x-opencode-session-id': h['x-opencode-session-id'] || session,
      'x-session-affinity': h['x-session-affinity'] || session,
      'x-session-id': h['x-session-id'] || session,
    },
    session,
    source: 'opencode-cli',
  }
}

/**
 * Return a fresh, real OpenCode fingerprint ({ headers, session, source }).
 * Results are cached for OPENCODE_FP_TTL_MS. Spawning opencode can be disabled
 * with OPENCODE_FP_DISABLE=1 (forces fallback).
 */
export async function getFingerprint({ force = false } = {}) {
  const now = Date.now()
  if (!force && _cache && now - _cacheAt < CACHE_TTL_MS) return _cache

  if (process.env.OPENCODE_FP_DISABLE === '1') {
    _cache = { ...FALLBACK_FP, source: 'fallback-disabled' }
    _cacheAt = now
    return _cache
  }

  const ca = generateCa()
  if (!ca) {
    // No openssl → cannot MITM → use fallback.
    _cache = { ...FALLBACK_FP, source: 'fallback-no-ca' }
    _cacheAt = now
    return _cache
  }

  let mitm = null
  try {
    const { server, port, captureState } = await startMitm(ca, (cap) => {
      _cache = buildFingerprintFromHeaders(cap.headers)
      _cacheAt = Date.now()
    })
    mitm = server
    const ok = await captureFromOpencode(port, captureState)
    if (ok && _cache && _cache.source === 'opencode-cli') {
      // success: _cache already set by the capture callback
    } else {
      _cache = { ...FALLBACK_FP, source: ok ? 'fallback-recapture' : 'fallback-spawn-failed' }
      _cacheAt = now
    }
  } catch {
    _cache = { ...FALLBACK_FP, source: 'fallback-exception' }
    _cacheAt = now
  } finally {
    if (mitm) try { mitm.close() } catch { /* ignore */ }
    try { if (ca.tmp) fs.rmSync(ca.tmp, { recursive: true, force: true }) } catch { /* ignore */ }
  }
  return _cache
}

export function fingerprintState() {
  return {
    cached: !!_cache,
    source: _cache?.source || null,
    session: _cache?.session || null,
    ageMs: _cache ? Date.now() - _cacheAt : null,
    ttlMs: CACHE_TTL_MS,
  }
}
