import type { ProxyConfig, ProxyType } from './types'
import { DEFAULT_PROXY } from './types'

/** Chuỗi hiển thị/nhập: host:port:user:pass hoặc host:port */
export function serializeProxy(proxy: ProxyConfig | null | undefined): string {
  if (!proxy || proxy.type === 'none' || !proxy.host?.trim() || !proxy.port) return ''
  const host = proxy.host.trim()
  const port = String(proxy.port)
  const user = (proxy.username ?? '').trim()
  const pass = proxy.password ?? ''
  if (user || pass) return `${host}:${port}:${user}:${pass}`
  return `${host}:${port}`
}

/**
 * Parse proxy dạng:
 * - host:port:user:pass
 * - host:port
 * - scheme://user:pass@host:port
 * - scheme://host:port
 */
export function parseProxyString(
  raw: string,
  fallbackType: ProxyType = 'http'
): ProxyConfig {
  const trimmed = (raw ?? '').trim()
  if (!trimmed) return { ...DEFAULT_PROXY }

  const schemeMatch = trimmed.match(/^(https?|socks5):\/\//i)
  let type: ProxyType = schemeMatch
    ? (schemeMatch[1].toLowerCase() as ProxyType)
    : fallbackType === 'none'
      ? 'http'
      : fallbackType

  let rest = schemeMatch ? trimmed.slice(schemeMatch[0].length) : trimmed

  // user:pass@host:port
  const atIdx = rest.lastIndexOf('@')
  if (atIdx > 0) {
    const auth = rest.slice(0, atIdx)
    const hostPort = rest.slice(atIdx + 1)
    const authColon = auth.indexOf(':')
    const username = authColon >= 0 ? auth.slice(0, authColon) : auth
    const password = authColon >= 0 ? auth.slice(authColon + 1) : ''
    const hp = splitHostPort(hostPort)
    if (!hp) return { ...DEFAULT_PROXY, type }
    return {
      type,
      host: hp.host,
      port: hp.port,
      username,
      password
    }
  }

  // host:port:user:pass (password có thể chứa ':')
  const parts = rest.split(':')
  if (parts.length >= 4) {
    const host = parts[0]?.trim() ?? ''
    const port = Number(parts[1])
    const username = parts[2] ?? ''
    const password = parts.slice(3).join(':')
    if (!host || !Number.isFinite(port) || port <= 0) return { ...DEFAULT_PROXY, type }
    return { type, host, port, username, password }
  }

  if (parts.length === 2) {
    const host = parts[0]?.trim() ?? ''
    const port = Number(parts[1])
    if (!host || !Number.isFinite(port) || port <= 0) return { ...DEFAULT_PROXY, type }
    return { type, host, port, username: '', password: '' }
  }

  if (parts.length === 3) {
    const host = parts[0]?.trim() ?? ''
    const port = Number(parts[1])
    const username = parts[2] ?? ''
    if (!host || !Number.isFinite(port) || port <= 0) return { ...DEFAULT_PROXY, type }
    return { type, host, port, username, password: '' }
  }

  return { ...DEFAULT_PROXY, type }
}

function splitHostPort(value: string): { host: string; port: number } | null {
  const idx = value.lastIndexOf(':')
  if (idx <= 0) return null
  const host = value.slice(0, idx).trim()
  const port = Number(value.slice(idx + 1))
  if (!host || !Number.isFinite(port) || port <= 0) return null
  return { host, port }
}

export function hasProxyAuth(proxy: ProxyConfig | null | undefined): boolean {
  return Boolean(proxy?.username?.trim() && proxy?.password)
}

/** Parse nhiều dòng proxy (bỏ dòng trống / không hợp lệ) */
export function parseProxyList(
  raw: string,
  fallbackType: ProxyType = 'http'
): ProxyConfig[] {
  return (raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => parseProxyString(line, fallbackType))
    .filter((p) => Boolean(p.host?.trim() && p.port))
    .map((p) => ({
      ...p,
      type: p.type === 'none' ? (fallbackType === 'none' ? 'http' : fallbackType) : p.type
    }))
}
