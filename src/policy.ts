import ipaddr from 'ipaddr.js'
import { domainToASCII } from 'node:url'
import { WebError } from '@deepseek-ai/dsh-web'

export type FetchableKind = 'html' | 'text'

export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

export type AddressResolver = (hostname: string, signal?: AbortSignal) => Promise<readonly ResolvedAddress[]>

/** Parse and validate the URL before any resolver or socket is touched. */
export function validateFetchUrl(input: string, maxUrlLength: number): URL {
  if (input.length > maxUrlLength) {
    throw new WebError(`URL exceeds the maximum length of ${maxUrlLength}`, 'WEB_INVALID_URL')
  }
  let url: URL
  try {
    url = new URL(input)
  } catch (cause) {
    throw new WebError('invalid URL', 'WEB_INVALID_URL', { cause })
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new WebError(`unsupported URL scheme "${url.protocol}"`, 'WEB_INVALID_URL')
  }
  if (url.username || url.password) {
    throw new WebError('credentials in URLs are not allowed', 'WEB_BLOCKED_URL')
  }
  return url
}

export function isSameOrigin(a: URL, b: URL): boolean {
  return a.protocol === b.protocol && normalizeHost(a.hostname) === normalizeHost(b.hostname) && a.port === b.port
}

/** Normalize a hostname for policy matching. URL already converts IDNs to ASCII. */
export function normalizeHost(hostname: string): string {
  const stripped = hostname.trim().replace(/^\[|\]$/g, '').toLowerCase()
  const withoutDot = stripped.endsWith('.') ? stripped.slice(0, -1) : stripped
  // URL.hostname is already ASCII/punycode, but profile configuration is
  // often written with Unicode labels. Normalize both sides identically.
  // Keep malformed entries unchanged so they fail closed rather than turning
  // into an unexpectedly broad match.
  const ascii = domainToASCII(withoutDot)
  return ascii || withoutDot
}

/**
 * Host entries are exact by default. Prefix an entry with `*.` to allow (or
 * deny) its subdomains; this avoids accidentally granting a whole tenant
 * namespace when a caller intended one host.
 */
export function hostAllowed(hostname: string, allowHosts: readonly string[], denyHosts: readonly string[]): boolean {
  const host = normalizeHost(hostname)
  if (denyHosts.some(entry => hostMatches(host, entry))) return false
  return allowHosts.length === 0 || allowHosts.some(entry => hostMatches(host, entry))
}

function hostMatches(host: string, configured: string): boolean {
  const raw = normalizeHost(configured.trim())
  if (!raw) return false
  if (raw.startsWith('*.')) {
    const base = raw.slice(2)
    return base.length > 0 && host !== base && host.endsWith(`.${base}`)
  }
  return host === raw
}

/** Return a literal URL host as an address, or undefined for a DNS name. */
export function literalAddress(hostname: string): ResolvedAddress | undefined {
  const clean = normalizeHost(hostname)
  if (!clean || clean.includes('%') || !ipaddr.isValid(clean)) return undefined
  const parsed = ipaddr.parse(clean)
  return { address: canonicalAddress(parsed), family: parsed.kind() === 'ipv4' ? 4 : 6 }
}

/** Return a stable identity independent of IPv6 textual compression. */
export function addressIdentity(address: string, family?: 4 | 6): string {
  const parsed = parseAddress(address)
  if (parsed === undefined) throw new Error(`invalid IP address: ${address}`)
  const actualFamily = parsed.kind() === 'ipv4' ? 4 : 6
  if (family !== undefined && family !== actualFamily) throw new Error(`address family mismatch: ${address}`)
  return `${actualFamily}:${canonicalAddress(parsed)}`
}

/** Explain why an address is not a globally routable destination. */
export function blockedAddressReason(address: string, family?: 4 | 6): string | undefined {
  const parsed = parseAddress(address)
  if (parsed === undefined) return 'invalid IP address'
  const actualFamily = parsed.kind() === 'ipv4' ? 4 : 6
  if (family !== undefined && family !== actualFamily) return 'address family mismatch'

  // Mapped IPv6 inherits the complete IPv4 special-purpose table. Do not let
  // `::ffff:10.0.0.1` evade the IPv4 policy by changing its textual family.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
    const mappedRange = (parsed as ipaddr.IPv6).toIPv4Address().range()
    return mappedRange === 'unicast' ? undefined : `IPv4-mapped ${mappedRange} address`
  }

  // Deprecated IPv4-compatible forms are not a public routing primitive. A
  // fail-closed policy is preferable to treating `::127.0.0.1` as ordinary
  // unicast merely because the modern mapped prefix is absent.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).parts.slice(0, 6).every((part: number) => part === 0) && (parsed as ipaddr.IPv6).parts[6] !== 0) {
    return 'IPv4-compatible IPv6 address'
  }

  const range = parsed.range()
  // ipaddr.js intentionally keeps the deprecated 6bone allocation as
  // `unicast`; it is not a globally routable destination for this policy.
  if (parsed.kind() === 'ipv6' && (parsed as ipaddr.IPv6).match(ipaddr.parseCIDR('3ffe::/16'))) {
    return 'IPv6 deprecated 6bone address'
  }
  return range === 'unicast' ? undefined : `${parsed.kind() === 'ipv4' ? 'IPv4' : 'IPv6'} ${range} address`
}

/** Validate every resolver answer before a transport can be constructed. */
export function validateResolvedAddresses(addresses: readonly ResolvedAddress[]): ResolvedAddress[] {
  if (addresses.length === 0) {
    throw new WebError('DNS returned no addresses', 'WEB_DNS_RESOLUTION_FAILED')
  }
  const seen = new Set<string>()
  const result: ResolvedAddress[] = []
  for (const item of addresses) {
    if (item.family !== 4 && item.family !== 6) {
      throw new WebError('DNS returned an invalid address family', 'WEB_DNS_RESOLUTION_FAILED')
    }
    const parsed = parseAddress(item.address)
    if (parsed === undefined || (parsed.kind() === 'ipv4' ? 4 : 6) !== item.family) {
      throw new WebError('DNS returned an invalid address family or address', 'WEB_DNS_RESOLUTION_FAILED')
    }
    const reason = blockedAddressReason(item.address, item.family)
    if (reason !== undefined) {
      throw new WebError(`destination address is blocked: ${reason}`, 'WEB_PRIVATE_ADDRESS_BLOCKED')
    }
    let identity: string
    let canonical: string
    try {
      identity = addressIdentity(item.address, item.family)
      canonical = canonicalAddress(parsed)
    } catch (cause) {
      throw new WebError('DNS returned an invalid address', 'WEB_DNS_RESOLUTION_FAILED', { cause })
    }
    if (!seen.has(identity)) {
      seen.add(identity)
      result.push({ address: canonical, family: item.family })
    }
  }
  return result
}

function parseAddress(address: string): ipaddr.IPv4 | ipaddr.IPv6 | undefined {
  const clean = normalizeHost(address)
  if (!clean || clean.includes('%') || !ipaddr.isValid(clean)) return undefined
  try {
    return ipaddr.parse(clean)
  } catch {
    return undefined
  }
}

function canonicalAddress(address: ipaddr.IPv4 | ipaddr.IPv6): string {
  return address.kind() === 'ipv4' ? (address as ipaddr.IPv4).toNormalizedString() : (address as ipaddr.IPv6).toRFC5952String()
}

export function classifyContentType(contentType: string | null): FetchableKind | undefined {
  const mime = (contentType ?? '').replace(/;.*$/s, '').trim().toLowerCase()
  if (mime === 'text/html' || mime === 'application/xhtml+xml') return 'html'
  if (mime.startsWith('text/') || mime === 'application/json' || mime === 'application/xml' || mime.endsWith('+json') || mime.endsWith('+xml')) return 'text'
  return undefined
}

export function parseCharset(contentType: string | null): string | undefined {
  return /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType ?? '')?.[1]?.trim().toLowerCase()
}

export function decoderForCharset(charset: string | undefined): TextDecoder {
  if (charset === undefined) return new TextDecoder('utf-8')
  try {
    return new TextDecoder(charset)
  } catch (cause) {
    throw new WebError(`unsupported charset "${charset}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE', { cause })
  }
}
