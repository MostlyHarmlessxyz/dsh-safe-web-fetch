import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import test from 'node:test'
import { UndiciSafeTransport } from '../src/transport.ts'

test('pins the socket to the supplied address while preserving the URL Host header', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.headers.host?.startsWith('public.test:'), true)
    response.writeHead(200, { 'content-type': 'text/plain' })
    response.end('pinned')
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve())
  })
  const address = server.address()
  assert.ok(address && typeof address === 'object')
  let resolverCalls = 0
  const transport = new UndiciSafeTransport(async () => {
    resolverCalls++
    return [{ address: '127.0.0.1', family: 4 }]
  })
  try {
    const response = await transport.request(new URL(`http://public.test:${address.port}/`), AbortSignal.timeout(2000), {})
    assert.equal(response.status, 200)
    assert.equal(await response.text(), 'pinned')
    assert.equal(resolverCalls, 1)
  } finally {
    await transport.close()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})

test('forwards an abort to an unresolved DNS resolver', async () => {
  const transport = new UndiciSafeTransport(async () => await new Promise(() => undefined))
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('test deadline')), 20)
  try {
    await assert.rejects(
      transport.request(new URL('http://public.test/'), controller.signal, {}),
      /test deadline|aborted/i,
    )
  } finally {
    clearTimeout(timer)
    await transport.close()
  }
})
