import { lookup } from 'node:dns/promises'
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import {
  classifyContentType,
  decoderForCharset,
  hostAllowed,
  isSameOrigin,
  literalAddress,
  normalizeHost,
  parseCharset,
  type AddressResolver,
  type ResolvedAddress,
  validateFetchUrl,
  validateResolvedAddresses,
} from './policy.js'
import { defaultTransportFactory } from './transport.js'
import type { SafeTransport, TransportFactory } from './transport.js'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647
const MAX_URL_LENGTH = 16_384
const MAX_RESPONSE_BYTES = 100_000_000
const MAX_BODY_CHARS = 10_000_000
const MAX_REDIRECTS = 20
const MAX_CONCURRENT_REQUESTS = 128

export const SAFE_FETCH_LIMITS = {
  maxUrlLength: MAX_URL_LENGTH,
  maxResponseBytes: MAX_RESPONSE_BYTES,
  maxBodyChars: MAX_BODY_CHARS,
  maxTimeoutMs: MAX_NODE_TIMER_DELAY_MS,
  maxRedirects: MAX_REDIRECTS,
  maxConcurrentRequests: MAX_CONCURRENT_REQUESTS,
} as const

export interface SafeWebFetchConfig {
  maxUrlLength: number
  maxResponseBytes: number
  maxBodyChars: number
  timeoutMs: number
  maxRedirects: number
  maxConcurrentRequests: number
  userAgent: string
  allowHosts: readonly string[]
  denyHosts: readonly string[]
}

export interface SafeWebFetchTestOptions {
  resolver?: AddressResolver
  transportFactory?: TransportFactory
}

/** A provider that refuses non-public destinations before opening a socket. */
export class SafeWebFetchProvider implements WebFetchProvider {
  readonly id = 'safe-http'
  private readonly resolver: AddressResolver
  private readonly transportFactory: TransportFactory
  private activeRequests = 0

  constructor(private readonly config: SafeWebFetchConfig, options: SafeWebFetchTestOptions = {}) {
    this.resolver = options.resolver ?? defaultResolver
    this.transportFactory = options.transportFactory ?? defaultTransportFactory
    assertConfig(config)
  }

  available(): boolean {
    return true
  }

  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (request === null || typeof request !== 'object' || typeof request.url !== 'string' || request.url.length === 0) {
      throw new WebError('a non-empty URL is required', 'WEB_INVALID_URL')
    }
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    if (this.activeRequests >= this.config.maxConcurrentRequests) {
      throw new WebError('too many concurrent web fetches', 'WEB_FETCH_CONCURRENCY_LIMIT')
    }
    this.activeRequests++
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    const timer = setTimeout(() => controller.abort(new TimeoutMarker()), this.config.timeoutMs)
    try {
      return await this.followAndRead(request.url, controller.signal)
    } catch (error: unknown) {
      throw translateError(error, controller.signal)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      this.activeRequests--
    }
  }

  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl, this.config.maxUrlLength)
    let redirectsFollowed = 0
    for (;;) {
      if (!hostAllowed(currentUrl.hostname, this.config.allowHosts, this.config.denyHosts)) {
        throw new WebError(`host is not allowed: ${currentUrl.hostname}`, 'WEB_HOST_NOT_ALLOWED')
      }
      const response = await this.requestOnce(currentUrl, signal)
      if (isRedirectStatus(response.response.status)) {
        try {
          if (redirectsFollowed >= this.config.maxRedirects) {
            throw new WebError(`exceeded the maximum of ${this.config.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.response.headers.get('location')
          if (location === null) throw new WebError('redirect response has no Location header', 'WEB_PROVIDER_ERROR')
          const target = validateFetchUrl(new URL(location, currentUrl).toString(), this.config.maxUrlLength)
          if (!isSameOrigin(target, currentUrl)) {
            throw new WebError(`cross-origin redirect to ${target.origin} is not followed automatically`, 'WEB_REDIRECT_BLOCKED')
          }
          currentUrl = target
          redirectsFollowed++
        } finally {
          await cancelBody(response.response)
          await closeTransport(response.transport)
        }
        continue
      }
      try {
        return await this.readBody(response.response, currentUrl, signal)
      } finally {
        await closeTransport(response.transport)
      }
    }
  }

  private async requestOnce(url: URL, signal: AbortSignal): Promise<{ response: Response; transport: SafeTransport }> {
    let addresses: readonly ResolvedAddress[]
    try {
      const literal = literalAddress(url.hostname)
      const pending = literal === undefined
        ? Promise.resolve().then(() => this.resolver(normalizeHost(url.hostname), signal))
        : Promise.resolve([literal])
      addresses = validateResolvedAddresses(await abortable(pending, signal))
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      // Preserve the outer deadline/caller cancellation. Converting an abort
      // into a DNS error would hide the actionable timeout/cancel code.
      if (signal.aborted) throw error
      throw new WebError(`DNS resolution failed for ${url.hostname}`, 'WEB_DNS_RESOLUTION_FAILED', { cause: error })
    }
    // The closure pins this hop to the exact set checked above. A fresh
    // transport per hop prevents a pooled connection from bypassing a new DNS
    // decision on a redirect or after a resolver answer changes.
    const pinnedResolver: AddressResolver = async () => addresses
    const transport = this.transportFactory(pinnedResolver)
    try {
      const response = await transport.request(url, signal, { 'user-agent': this.config.userAgent })
      return { response, transport }
    } catch (error) {
      await closeTransport(transport)
      throw error
    }
  }

  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const kind = classifyContentType(response.headers.get('content-type'))
    if (kind === undefined) {
      await cancelBody(response)
      throw new WebError('unsupported content type', 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(response.headers.get('content-type')))
    } catch (error) {
      await cancelBody(response)
      throw error
    }
    const declared = response.headers.get('content-length')
    if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > this.config.maxResponseBytes) {
      await cancelBody(response)
      throw new WebError(`response exceeds ${this.config.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
    }
    if (response.body === null) {
      return { url: finalUrl.toString(), statusCode: response.status, body: { kind, content: '' }, truncated: false }
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    try {
      for (;;) {
        const { done, value } = await abortable(reader.read(), signal)
        if (done) break
        const remaining = this.config.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, Math.max(0, remaining)))
          total += Math.max(0, remaining)
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.config.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.config.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }
    return { url: finalUrl.toString(), statusCode: response.status, body, truncated: truncatedByBytes || truncatedByChars }
  }
}

class TimeoutMarker extends Error {}

function translateError(error: unknown, signal: AbortSignal): WebError {
  if (error instanceof WebError) return error
  if (signal.aborted) {
    if (signal.reason instanceof TimeoutMarker) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: error })
    return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  }
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}

function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Best-effort body cancellation that never replaces the primary error. */
async function cancelBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  } catch {
    // The socket/dispatcher close below remains the authoritative cleanup.
  }
}

/** Close a per-hop dispatcher without allowing a broken close to mask a fetch result. */
async function closeTransport(transport: SafeTransport): Promise<void> {
  const close = Promise.resolve().then(() => transport.close())
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<void>(resolve => {
    timer = setTimeout(resolve, 1_000)
  })
  try {
    await Promise.race([close, timeout])
  } catch {
    // Cleanup failures are intentionally not surfaced as provider data errors.
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

async function defaultResolver(hostname: string): Promise<readonly ResolvedAddress[]> {
  const answers = await lookup(hostname, { all: true, verbatim: true })
  return answers.map(answer => ({ address: answer.address, family: answer.family as 4 | 6 }))
}

/** Race DNS (including third-party resolvers) against the provider signal. */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new Error('aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    return await Promise.race([promise, aborted])
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort)
  }
}

function assertConfig(config: SafeWebFetchConfig): void {
  for (const [name, value] of Object.entries(config)) {
    if (name.endsWith('Hosts')) {
      if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
        throw new Error(`safe-web-fetch: ${name} must be an array of strings`)
      }
      continue
    }
    if (name === 'userAgent') {
      if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) throw new Error('safe-web-fetch: userAgent must be non-empty and contain no CR/LF')
      continue
    }
    if (name === 'maxRedirects') {
      if (!Number.isSafeInteger(value) || value < 0 || value > MAX_REDIRECTS) throw new Error(`safe-web-fetch: ${name} must be an integer between 0 and ${MAX_REDIRECTS}`)
    } else if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`safe-web-fetch: ${name} must be a positive safe integer`)
    }
  }
  if (config.maxUrlLength > MAX_URL_LENGTH) throw new Error(`safe-web-fetch: maxUrlLength must be no greater than ${MAX_URL_LENGTH}`)
  if (config.maxResponseBytes > MAX_RESPONSE_BYTES) throw new Error(`safe-web-fetch: maxResponseBytes must be no greater than ${MAX_RESPONSE_BYTES}`)
  if (config.maxBodyChars > MAX_BODY_CHARS) throw new Error(`safe-web-fetch: maxBodyChars must be no greater than ${MAX_BODY_CHARS}`)
  if (config.maxConcurrentRequests > MAX_CONCURRENT_REQUESTS) throw new Error(`safe-web-fetch: maxConcurrentRequests must be no greater than ${MAX_CONCURRENT_REQUESTS}`)
  if (config.timeoutMs > MAX_NODE_TIMER_DELAY_MS) throw new Error('safe-web-fetch: timeoutMs is too large')
}

export function createSafeProvider(config: SafeWebFetchConfig, options?: SafeWebFetchTestOptions): SafeWebFetchProvider {
  return new SafeWebFetchProvider(config, options)
}
