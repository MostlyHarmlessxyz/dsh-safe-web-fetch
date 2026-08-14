/**
 * `dsh-safe-web-fetch`: a public-only HTTP(S) provider for DSH's `ctx.web`
 * capability. The provider is intentionally a function plugin: DSH owns the
 * capability and model-facing tool; this package supplies only the transport.
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { SAFE_FETCH_LIMITS, SafeWebFetchProvider } from './provider.js'
import type { SafeWebFetchConfig } from './provider.js'

export { SafeWebFetchProvider, createSafeProvider } from './provider.js'
export { SAFE_FETCH_LIMITS } from './provider.js'
export type { SafeWebFetchConfig, SafeWebFetchTestOptions } from './provider.js'
export {
  addressIdentity,
  blockedAddressReason,
  classifyContentType,
  decoderForCharset,
  hostAllowed,
  literalAddress,
  isSameOrigin,
  normalizeHost,
  parseCharset,
  validateFetchUrl,
  validateResolvedAddresses,
} from './policy.js'
export type { AddressResolver, FetchableKind, ResolvedAddress } from './policy.js'
export { UndiciSafeTransport } from './transport.js'
export type { SafeTransport, TransportFactory } from './transport.js'

export const name = 'safe-web-fetch'
export const inject = ['web']

export const DEFAULT_USER_AGENT = 'dsh-safe-web-fetch/0.1 (+https://github.com/MostlyHarmlessxyz/dsh-safe-web-fetch)'

export interface Config {
  maxUrlLength?: number
  maxResponseBytes?: number
  maxBodyChars?: number
  timeoutMs?: number
  maxRedirects?: number
  maxConcurrentRequests?: number
  userAgent?: string
  allowHosts?: string[]
  denyHosts?: string[]
}

export const Config: z<Config> = z.object({
  maxUrlLength: z.number().step(1).min(1).max(SAFE_FETCH_LIMITS.maxUrlLength).default(2048),
  maxResponseBytes: z.number().step(1).min(1).max(SAFE_FETCH_LIMITS.maxResponseBytes).default(5_000_000),
  maxBodyChars: z.number().step(1).min(1).max(SAFE_FETCH_LIMITS.maxBodyChars).default(100_000),
  timeoutMs: z.number().step(1).min(1).max(SAFE_FETCH_LIMITS.maxTimeoutMs).default(30_000),
  maxRedirects: z.number().step(1).min(0).max(SAFE_FETCH_LIMITS.maxRedirects).default(5),
  maxConcurrentRequests: z.number().step(1).min(1).max(SAFE_FETCH_LIMITS.maxConcurrentRequests).default(16),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  allowHosts: z.array(z.string()).default([]),
  denyHosts: z.array(z.string()).default([]),
})

export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  const providerConfig: SafeWebFetchConfig = {
    maxUrlLength: resolved.maxUrlLength,
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    maxConcurrentRequests: resolved.maxConcurrentRequests,
    userAgent: resolved.userAgent,
    allowHosts: resolved.allowHosts,
    denyHosts: resolved.denyHosts,
  }
  ctx.web.registerFetchProvider(new SafeWebFetchProvider(providerConfig))
}
