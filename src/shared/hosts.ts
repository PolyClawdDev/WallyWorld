/** Hostnames that mean "this machine" rather than another player on the LAN. */
export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
}

/**
 * Private / link-local / mDNS names. Friends on the same Wi-Fi use these;
 * they are not a public internet address.
 */
export function isLanHostname(hostname: string): boolean {
  if (hostname.toLowerCase().endsWith('.local')) return true
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
  if (/^169\.254\.\d{1,3}\.\d{1,3}$/.test(hostname)) return true
  const match = hostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (!match) return false
  const second = Number(match[1])
  return second >= 16 && second <= 31
}

export function isPrivateSiteHostname(hostname: string): boolean {
  return isLoopbackHostname(hostname) || isLanHostname(hostname)
}

/** `192.168.1.5:5173` or `[::1]:5173` → hostname only. */
export function hostnameOf(host: string): string {
  if (host.startsWith('[')) {
    const end = host.indexOf(']')
    return end >= 0 ? host.slice(1, end) : host
  }
  const colon = host.lastIndexOf(':')
  if (colon > 0 && /^\d+$/.test(host.slice(colon + 1))) return host.slice(0, colon)
  return host
}
