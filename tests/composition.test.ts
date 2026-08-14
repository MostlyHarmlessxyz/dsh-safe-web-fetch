import { strict as assert } from 'node:assert'
import test from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as safePlugin from '../src/index.ts'

const config = {
  maxUrlLength: 2048,
  maxResponseBytes: 1024,
  maxBodyChars: 100,
  timeoutMs: 1000,
  maxRedirects: 0,
  maxConcurrentRequests: 4,
  userAgent: 'composition-test',
  allowHosts: [],
  denyHosts: [],
}

test('exports a named function plugin and no default', () => {
  assert.equal('default' in safePlugin, false)
  assert.equal(safePlugin.name, 'safe-web-fetch')
  assert.deepEqual(safePlugin.inject, ['web'])
  assert.equal(typeof safePlugin.apply, 'function')
})

test('registers and disposes the provider through a real Cordis WebRuntime', async () => {
  const ctx = new Context()
  await ctx.plugin(WebRuntime, { fetchProvider: 'safe-http' })
  const fiber = await ctx.plugin(safePlugin, config)

  await assert.rejects(
    ctx.web.fetch({ url: 'http://127.0.0.1/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_PRIVATE_ADDRESS_BLOCKED',
  )

  await fiber.dispose()
  await assert.rejects(
    ctx.web.fetch({ url: 'http://127.0.0.1/' }),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_PROVIDER_CONFIGURED_MISSING',
  )
})
