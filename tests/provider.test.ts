import { strict as assert } from 'node:assert'
import test from 'node:test'
import { createSafeProvider, type SafeWebFetchConfig } from '../src/provider.ts'
import type { SafeTransport, TransportFactory } from '../src/transport.ts'
import type { AddressResolver, ResolvedAddress } from '../src/policy.ts'

const PUBLIC: ResolvedAddress = { address: '93.184.216.34', family: 4 }

const baseConfig: SafeWebFetchConfig = {
  maxUrlLength: 2048,
  maxResponseBytes: 1024,
  maxBodyChars: 100,
  timeoutMs: 1000,
  maxRedirects: 3,
  maxConcurrentRequests: 4,
  userAgent: 'test-agent',
  allowHosts: [],
  denyHosts: [],
}

type Script = (url: URL, signal: AbortSignal, headers: Record<string, string>) => Promise<Response>

function scriptedFactory(scripts: Script[], state: { requests: URL[]; closes: number }): TransportFactory {
  return () => {
    const script = scripts.shift()
    if (!script) throw new Error('unexpected transport construction')
    return {
      request: async (url, signal, headers) => {
        state.requests.push(url)
        return await script(url, signal, headers)
      },
      close: async () => { state.closes++ },
    } satisfies SafeTransport
  }
}

function textResponse(content: string, init: ResponseInit = {}): Response {
  return new Response(content, {
    status: 200,
    headers: { 'content-type': 'text/plain; charset=utf-8', ...init.headers },
    ...init,
  })
}

function resolverFor(addresses: readonly ResolvedAddress[] = [PUBLIC], seen: string[] = []): AddressResolver {
  return async hostname => {
    seen.push(hostname)
    return addresses
  }
}

test('fetches a public text resource through the pinned transport', async () => {
  const state = { requests: [] as URL[], closes: 0 }
  let receivedHeaders: Record<string, string> | undefined
  const provider = createSafeProvider(baseConfig, {
    resolver: resolverFor(),
    transportFactory: scriptedFactory([
      async (_url, _signal, headers) => {
        receivedHeaders = headers
        return textResponse('hello')
      },
    ], state),
  })

  const result = await provider.fetch({ url: 'https://example.com/hello' })
  assert.deepEqual(result, {
    url: 'https://example.com/hello',
    statusCode: 200,
    body: { kind: 'text', content: 'hello' },
    truncated: false,
  })
  assert.equal(receivedHeaders?.['user-agent'], 'test-agent')
  assert.equal(state.requests.length, 1)
  assert.equal(state.closes, 1)
})

test('blocks a private answer before creating a transport', async () => {
  let transports = 0
  const provider = createSafeProvider(baseConfig, {
    resolver: resolverFor([{ address: '10.0.0.5', family: 4 }]),
    transportFactory: () => {
      transports++
      throw new Error('must not construct')
    },
  })
  await assert.rejects(
    provider.fetch({ url: 'https://example.com/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_PRIVATE_ADDRESS_BLOCKED',
  )
  assert.equal(transports, 0)
})

test('blocks an IPv6 literal before invoking a resolver', async () => {
  let resolverCalls = 0
  const provider = createSafeProvider(baseConfig, {
    resolver: async () => {
      resolverCalls++
      return [PUBLIC]
    },
    transportFactory: () => { throw new Error('must not construct') },
  })
  await assert.rejects(
    provider.fetch({ url: 'http://[::1]/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_PRIVATE_ADDRESS_BLOCKED',
  )
  assert.equal(resolverCalls, 0)
})

test('re-resolves and revalidates every same-origin redirect hop', async () => {
  const state = { requests: [] as URL[], closes: 0 }
  const hosts: string[] = []
  const provider = createSafeProvider(baseConfig, {
    resolver: resolverFor([PUBLIC], hosts),
    transportFactory: scriptedFactory([
      async () => new Response(null, { status: 302, headers: { location: '/next' } }),
      async () => textResponse('final'),
    ], state),
  })
  const result = await provider.fetch({ url: 'https://example.com/start' })
  assert.equal(result.body.content, 'final')
  assert.deepEqual(state.requests.map(url => url.pathname), ['/start', '/next'])
  assert.deepEqual(hosts, ['example.com', 'example.com'])
  assert.equal(state.closes, 2)
})

test('does not contact a cross-origin redirect target', async () => {
  const state = { requests: [] as URL[], closes: 0 }
  const provider = createSafeProvider(baseConfig, {
    resolver: resolverFor(),
    transportFactory: scriptedFactory([
      async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }),
    ], state),
  })
  await assert.rejects(
    provider.fetch({ url: 'https://example.com/start' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_REDIRECT_BLOCKED',
  )
  assert.equal(state.requests.length, 1)
  assert.equal(state.closes, 1)
})

test('enforces host policy on the URL before DNS', async () => {
  const hosts: string[] = []
  const provider = createSafeProvider({ ...baseConfig, allowHosts: ['allowed.example'] }, {
    resolver: resolverFor([PUBLIC], hosts),
    transportFactory: () => { throw new Error('must not construct') },
  })
  await assert.rejects(
    provider.fetch({ url: 'https://other.example/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_HOST_NOT_ALLOWED',
  )
  assert.deepEqual(hosts, [])
})

test('caps body bytes/chars and marks truncation', async () => {
  const provider = createSafeProvider({ ...baseConfig, maxResponseBytes: 5, maxBodyChars: 3 }, {
    resolver: resolverFor(),
    transportFactory: scriptedFactory([async () => textResponse('abcdefgh')], { requests: [], closes: 0 }),
  })
  const result = await provider.fetch({ url: 'https://example.com/' })
  assert.equal(result.body.content, 'abc')
  assert.equal(result.truncated, true)
})

test('rejects unsupported content types without returning bytes', async () => {
  const provider = createSafeProvider(baseConfig, {
    resolver: resolverFor(),
    transportFactory: scriptedFactory([async () => new Response('binary', { status: 200, headers: { 'content-type': 'application/octet-stream' } })], { requests: [], closes: 0 }),
  })
  await assert.rejects(
    provider.fetch({ url: 'https://example.com/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_UNSUPPORTED_CONTENT_TYPE',
  )
})

test('maps provider timeout and caller cancellation separately', async () => {
  const waitingFactory: TransportFactory = () => ({
    request: async (_url, signal) => await new Promise<Response>((_resolve, reject) => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    }),
    close: async () => undefined,
  })
  const timeoutProvider = createSafeProvider({ ...baseConfig, timeoutMs: 10 }, { resolver: resolverFor(), transportFactory: waitingFactory })
  await assert.rejects(timeoutProvider.fetch({ url: 'https://example.com/' }), error => error instanceof Error && 'code' in error && error.code === 'WEB_FETCH_TIMEOUT')

  const controller = new AbortController()
  const abortProvider = createSafeProvider({ ...baseConfig, timeoutMs: 1000 }, { resolver: resolverFor(), transportFactory: waitingFactory })
  const pending = abortProvider.fetch({ url: 'https://example.com/' }, controller.signal)
  controller.abort()
  await assert.rejects(pending, error => error instanceof Error && 'code' in error && error.code === 'WEB_ABORTED')
})

test('bounds a resolver that never settles', async () => {
  const provider = createSafeProvider({ ...baseConfig, timeoutMs: 10 }, {
    resolver: async () => await new Promise<readonly ResolvedAddress[]>(() => undefined),
    transportFactory: () => { throw new Error('must not construct') },
  })
  await assert.rejects(
    provider.fetch({ url: 'https://example.com/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_FETCH_TIMEOUT',
  )
})

test('rejects malformed capability requests with a stable WebError code', async () => {
  const provider = createSafeProvider(baseConfig, { resolver: resolverFor() })
  for (const request of [null, undefined, {}, { url: '' }, { url: 42 }] as unknown[]) {
    await assert.rejects(
      provider.fetch(request as never),
      error => error instanceof Error && 'code' in error && error.code === 'WEB_INVALID_URL',
    )
  }
})

test('caps concurrent requests before starting another resolver or transport', async () => {
  let started = 0
  let release: (() => void) | undefined
  const waitingFactory: TransportFactory = () => ({
    request: async (_url, signal) => {
      started++
      await new Promise<void>(resolve => { release = resolve })
      if (signal.aborted) throw signal.reason
      return textResponse('done')
    },
    close: async () => undefined,
  })
  const provider = createSafeProvider({ ...baseConfig, maxConcurrentRequests: 1, timeoutMs: 1000 }, {
    resolver: resolverFor(),
    transportFactory: waitingFactory,
  })
  const first = provider.fetch({ url: 'https://example.com/first' })
  while (started === 0) await new Promise(resolve => setImmediate(resolve))
  await assert.rejects(
    provider.fetch({ url: 'https://example.com/second' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_FETCH_CONCURRENCY_LIMIT',
  )
  release?.()
  await first
  assert.equal(started, 1)
})
