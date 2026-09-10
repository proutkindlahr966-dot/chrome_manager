import { anonymizeProxy, closeAnonymizedProxy } from 'proxy-chain'
import type { ProxyConfig } from '../../shared/types'
import { hasProxyAuth } from '../../shared/proxy'

/** URL local proxy (http://127.0.0.1:port) theo profileId */
const localProxies = new Map<string, string>()

/** URL upstream đầy đủ cho proxy-chain / --proxy-server */
export function toUpstreamProxyUrl(proxy: ProxyConfig): string | null {
  if (!proxy || proxy.type === 'none' || !proxy.host?.trim() || !proxy.port) return null
  const host = proxy.host.trim()
  const port = proxy.port
  const user = (proxy.username ?? '').trim()
  const pass = proxy.password ?? ''
  const scheme = proxy.type === 'socks5' ? 'socks5' : proxy.type === 'https' ? 'https' : 'http'
  if (user || pass) {
    return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${host}:${port}`
  }
  return `${scheme}://${host}:${port}`
}

/**
 * Chrome không hỗ trợ SOCKS5 (và HTTP) auth trong --proxy-server.
 * Với proxy có user/pass → tạo local HTTP proxy (proxy-chain) forward kèm auth.
 * Không auth → trả URL upstream trực tiếp.
 */
export async function resolveChromeProxyServer(
  profileId: string,
  proxy: ProxyConfig
): Promise<string | null> {
  await stopProxyRelay(profileId)

  const upstream = toUpstreamProxyUrl(proxy)
  if (!upstream) return null

  if (!hasProxyAuth(proxy)) {
    return upstream
  }

  try {
    const localUrl = await anonymizeProxy(upstream)
    localProxies.set(profileId, localUrl)
    return localUrl
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`Không tạo được proxy relay: ${msg}`)
  }
}

export async function stopProxyRelay(profileId: string): Promise<void> {
  const localUrl = localProxies.get(profileId)
  if (!localUrl) return
  localProxies.delete(profileId)
  try {
    await closeAnonymizedProxy(localUrl, true)
  } catch {
    // ignore
  }
}

export async function stopAllProxyRelays(): Promise<void> {
  const ids = [...localProxies.keys()]
  await Promise.all(ids.map((id) => stopProxyRelay(id)))
}
