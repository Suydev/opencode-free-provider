import fs from 'node:fs'

const DEFAULT_PROXY_POOL_FILE = process.env.PROXY_POOL_FILE || ''
let proxies = []
let index = 0
let loaded = false

function normalize(line) {
  const raw = String(line || '').trim()
  if (!raw || raw.startsWith('#')) return null
  if (/^https?:\/\//i.test(raw)) return raw
  return `http://${raw}`
}

export function loadProxyPool() {
  if (loaded) return proxies
  loaded = true
  if (!DEFAULT_PROXY_POOL_FILE) return proxies
  try {
    const text = fs.readFileSync(DEFAULT_PROXY_POOL_FILE, 'utf8')
    proxies = text.split(/\r?\n/).map(normalize).filter(Boolean)
  } catch (err) {
    console.warn(`[opencode-free-provider] proxy pool load failed: ${err.message}`)
  }
  return proxies
}

export function currentProxy() {
  loadProxyPool()
  return proxies.length ? proxies[index % proxies.length] : null
}

export function rotateProxy(reason = '') {
  loadProxyPool()
  if (!proxies.length) return null
  index = (index + 1) % proxies.length
  const next = proxies[index]
  if (reason) console.warn(`[opencode-free-provider] rotated proxy -> ${maskProxy(next)} (${reason})`)
  return next
}

export function proxyState() {
  loadProxyPool()
  return {
    file: DEFAULT_PROXY_POOL_FILE || null,
    count: proxies.length,
    index: proxies.length ? index % proxies.length : null,
    current: currentProxy() ? maskProxy(currentProxy()) : null,
  }
}

function maskProxy(proxy) {
  try {
    const url = new URL(proxy)
    return `${url.protocol}//${url.username ? '***:' : ''}${url.host}`
  } catch {
    return proxy
  }
}

let _undici = null
let _agent = null
let _agentFor = null

// Node's global fetch is backed by an internal, older undici copy that rejects
// dispatchers from the standalone `undici` package (`invalid onRequestStart
// method`). When proxying, use undici's own fetch so the agent and fetch come
// from the same package. Cached across requests; ProxyAgent is reused per proxy.
async function nodeProxiedFetch(proxy) {
  if (!_undici) _undici = await import('undici')
  if (!_agent || _agentFor !== proxy) {
    _agent = new _undici.ProxyAgent(proxy)
    _agentFor = proxy
  }
  return (url, options = {}) => _undici.fetch(url, { ...options, dispatcher: _agent })
}

export async function fetchWithProxy(url, options = {}) {
  const proxy = currentProxy()
  const opts = { ...options }
  if (!proxy) return fetch(url, opts)
  if (typeof Bun !== 'undefined') {
    opts.proxy = proxy
    return fetch(url, opts)
  }
  const proxiedFetch = await nodeProxiedFetch(proxy)
  return proxiedFetch(url, opts)
}
