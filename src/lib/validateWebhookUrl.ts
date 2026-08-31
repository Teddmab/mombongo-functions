import * as net from 'net'

const DISALLOWED_HOSTNAME_SUFFIXES = ['.local', '.internal', '.localhost']
const DISALLOWED_HOSTNAMES = new Set(['localhost', '0.0.0.0'])

/**
 * A partner's webhookUrl is where Mombongo's own server later makes an
 * outbound HTTP call from (notifyPartnerPaymentComplete) — an admin
 * setting this to an internal/private target is a real SSRF exposure, not
 * just a data-quality concern. Rejects http://, localhost/.internal/.local
 * hostnames, and IP literals in loopback/private/link-local ranges.
 *
 * Known limitation: this checks the hostname/IP literal as written, not
 * what it resolves to — a public hostname that resolves to a private IP
 * (DNS rebinding) would pass. Not hardened against that here; the actor
 * setting this value today is always a trusted Mombongo admin (there is
 * no partner self-service path yet), which is why that gap is accepted
 * for now rather than adding resolution-time checks.
 */
export function validateWebhookUrl(raw: string): { valid: true } | { valid: false; reason: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { valid: false, reason: 'URL invalide' }
  }

  if (url.protocol !== 'https:') {
    return { valid: false, reason: 'L\'URL doit utiliser https://' }
  }

  // URL.hostname keeps the brackets for an IPv6 literal (e.g. "[::1]") —
  // net.isIPv6 expects them stripped.
  const rawHostname = url.hostname.toLowerCase()
  const hostname = rawHostname.startsWith('[') && rawHostname.endsWith(']')
    ? rawHostname.slice(1, -1)
    : rawHostname

  if (DISALLOWED_HOSTNAMES.has(hostname) || DISALLOWED_HOSTNAME_SUFFIXES.some((s) => hostname.endsWith(s))) {
    return { valid: false, reason: 'Hôte interne ou local non autorisé' }
  }

  if (net.isIPv4(hostname) && isPrivateOrLoopbackIpv4(hostname)) {
    return { valid: false, reason: 'Adresse IP privée ou locale non autorisée' }
  }
  if (net.isIPv6(hostname) && isPrivateOrLoopbackIpv6(hostname)) {
    return { valid: false, reason: 'Adresse IP privée ou locale non autorisée' }
  }

  return { valid: true }
}

function isPrivateOrLoopbackIpv4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number)
  if (a === 127) return true // loopback
  if (a === 10) return true // 10.0.0.0/8
  if (a === 172 && b >= 16 && b <= 31) return true // 172.16.0.0/12
  if (a === 192 && b === 168) return true // 192.168.0.0/16
  if (a === 169 && b === 254) return true // link-local
  if (a === 0) return true // "this network"
  return false
}

function isPrivateOrLoopbackIpv6(ip: string): boolean {
  const lower = ip.toLowerCase()
  if (lower === '::1') return true // loopback
  if (lower.startsWith('fe80:')) return true // link-local
  if (lower.startsWith('fc') || lower.startsWith('fd')) return true // unique local (fc00::/7)
  return false
}
