import { lookup as lookupDns } from 'node:dns'
import { promisify } from 'node:util'
import { Agent, fetch as undiciFetch, interceptors } from 'undici'
import type { Dispatcher } from 'undici'
import type { AddressResolver } from './policy.js'

const lookupAll = promisify(lookupDns)

export interface SafeTransport {
  request(url: URL, signal: AbortSignal, headers: Record<string, string>): Promise<Response>
  close(): Promise<void>
}

export type TransportFactory = (resolver: AddressResolver) => SafeTransport

/**
 * DNS interceptor storage scoped to one transport/one request hop.
 *
 * Undici needs to read the records back immediately after `lookup` stores
 * them. A no-op `set`/`get` pair looks attractive but makes the interceptor
 * fail between those two operations. Keeping this tiny map is safe because a
 * provider creates a fresh transport for every redirect hop and closes it
 * after the response body is consumed; no answer survives a hop.
 */
function createDnsStorage(): interceptors.DNSStorage {
  const records = new Map<string, interceptors.DNSInterceptorOriginRecords>()
  return {
    get size() { return records.size },
    get(origin) { return records.get(origin) ?? null },
    set(origin, value) {
      if (value === null) records.delete(origin)
      else records.set(origin, value)
    },
    delete(origin) { records.delete(origin) },
    full() { return false },
  }
}

/** Resolve every A/AAAA answer without consulting process-global proxy state. */
export const systemResolver: AddressResolver = async hostname => {
  const result = await lookupAll(hostname, { all: true, verbatim: true }) as readonly { address: string; family: number }[]
  return result.map(entry => ({ address: entry.address, family: entry.family as 4 | 6 }))
}

/**
 * Undici transport with DNS interceptor pinning. The interceptor rewrites the
 * socket origin to the selected validated IP while preserving Host and TLS SNI.
 * A fresh Agent is created for each provider fetch/redirect hop, so the scoped
 * storage cannot carry a DNS answer across policy decisions.
 */
export class UndiciSafeTransport implements SafeTransport {
  private agent: Dispatcher | undefined
  private abortCleanup: (() => void) | undefined

  constructor(private readonly resolver: AddressResolver) {}

  async request(url: URL, signal: AbortSignal, headers: Record<string, string>): Promise<Response> {
    if (this.agent !== undefined) throw new Error('safe transport cannot issue concurrent requests')
    if (signal.aborted) throw signal.reason ?? new Error('aborted')
    // Install our own forwarding controller before invoking undici. This
    // closes the small race where an external timeout fires while undici is
    // still constructing its fetch controller (which otherwise can leave a
    // DNS interceptor callback pending forever).
    const requestController = new AbortController()
    const onAbort = () => requestController.abort(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    this.abortCleanup = () => signal.removeEventListener('abort', onAbort)
    const requestSignal = requestController.signal
    const agent = new Agent({
      connectTimeout: 30_000,
      pipelining: 0,
    })
    // Undici's `interceptors` option is only carried through Agent/Pool
    // options; it is not composed automatically. Compose on the dispatcher
    // itself so the DNS rewrite actually runs before socket creation.
    const dispatcher = agent.compose(interceptors.dns({
      dualStack: true,
      maxTTL: 60_000,
      storage: createDnsStorage(),
      lookup: (origin, _options, callback) => {
        void abortable(Promise.resolve().then(() => this.resolver(origin.hostname, requestSignal)), requestSignal)
          .then(addresses => callback(null, addresses.map(address => ({ ...address, ttl: 60_000 }))))
          .catch(error => callback(error as NodeJS.ErrnoException, []))
      },
    }))
    this.agent = dispatcher
    try {
      return await undiciFetch(url, {
        method: 'GET',
        redirect: 'manual',
        dispatcher,
        headers: {
          ...headers,
          accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
        },
        signal: requestSignal,
      }) as unknown as Response
    } catch (error) {
      await this.close()
      throw error
    }
  }

  async close(): Promise<void> {
    const agent = this.agent
    this.agent = undefined
    const abortCleanup = this.abortCleanup
    this.abortCleanup = undefined
    abortCleanup?.()
    if (agent !== undefined) await agent.close()
  }
}

export const defaultTransportFactory: TransportFactory = resolver => new UndiciSafeTransport(resolver)

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
