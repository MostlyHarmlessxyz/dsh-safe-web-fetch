import { strict as assert } from 'node:assert'
import test from 'node:test'
import {
  addressIdentity,
  blockedAddressReason,
  hostAllowed,
  literalAddress,
  isSameOrigin,
  validateFetchUrl,
  validateResolvedAddresses,
} from '../src/policy.ts'

test('blocks private, special-purpose, multicast, and mapped destinations', () => {
  const blockedV4 = [
    '0.0.0.0',
    '10.1.2.3',
    '100.64.0.1',
    '127.0.0.1',
    '169.254.10.20',
    '172.16.0.1',
    '192.0.2.1',
    '192.168.1.1',
    '198.18.0.1',
    '198.51.100.10',
    '203.0.113.10',
    '224.0.0.1',
  ]
  for (const address of blockedV4) {
    assert.notEqual(blockedAddressReason(address, 4), undefined, address)
  }

  const blockedV6 = [
    '::',
    '::1',
    'fc00::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
    '2001:0::1',
    '2001:2::1',
    '2001:4:112::1',
    '2001:10::1',
    'fec0::1',
    '100::1',
    '3fff::1',
    '64:ff9b::c000:201',
  ]
  for (const address of blockedV6) {
    assert.notEqual(blockedAddressReason(address, 6), undefined, address)
  }

  assert.equal(blockedAddressReason('8.8.8.8', 4), undefined)
  assert.equal(blockedAddressReason('2001:4860:4860::8888', 6), undefined)
})

test('rejects a mixed DNS answer before transport construction', () => {
  assert.throws(
    () => validateResolvedAddresses([
      { address: '93.184.216.34', family: 4 },
      { address: '127.0.0.1', family: 4 },
    ]),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_PRIVATE_ADDRESS_BLOCKED',
  )
})

test('classifies a resolver family mismatch as a DNS failure, not a private target', () => {
  assert.throws(
    () => validateResolvedAddresses([{ address: '8.8.8.8', family: 6 }]),
    error => error instanceof Error && 'code' in error && error.code === 'WEB_DNS_RESOLUTION_FAILED',
  )
})

test('deduplicates validated answers and normalizes their identity', () => {
  const result = validateResolvedAddresses([
    { address: '93.184.216.34', family: 4 },
    { address: '93.184.216.34', family: 4 },
  ])
  assert.deepEqual(result, [{ address: '93.184.216.34', family: 4 }])
  assert.equal(addressIdentity('93.184.216.34', 4), addressIdentity('93.184.216.34', 4))
})

test('canonicalizes URL forms before policy checks', () => {
  assert.equal(validateFetchUrl('http://2130706433/', 2048).hostname, '127.0.0.1')
  assert.equal(validateFetchUrl('http://0x7f000001/', 2048).hostname, '127.0.0.1')
  assert.throws(() => validateFetchUrl('ftp://example.com/', 2048), /unsupported URL scheme/)
  assert.throws(() => validateFetchUrl('http://user:pass@example.com/', 2048), /credentials/)
  assert.throws(() => validateFetchUrl(`http://${'a'.repeat(2100)}.example/`, 2048), /maximum length/)
})

test('host allow and deny rules use label boundaries', () => {
  assert.equal(hostAllowed('api.example.com.', [], []), true)
  assert.equal(hostAllowed('api.example.com', ['*.example.com'], []), true)
  assert.equal(hostAllowed('example.com', ['*.example.com'], []), false)
  assert.equal(hostAllowed('badexample.com', ['example.com'], []), false)
  assert.equal(hostAllowed('api.example.com', [], ['*.example.com']), false)
  assert.equal(hostAllowed('api.example.com', ['example.com'], ['api.example.com']), false)
  assert.equal(hostAllowed('api.example.com', ['*.example.com'], []), true)
  assert.equal(hostAllowed('api.example.com', ['example.com'], []), false)
  assert.equal(hostAllowed('xn--r8jz45g.xn--zckzah', ['例え.テスト'], []), true)
})

test('blocks deprecated 6bone addresses that ipaddr.js labels unicast', () => {
  assert.notEqual(blockedAddressReason('3ffe::1', 6), undefined)
})

test('detects literal IPv4 and IPv6 hosts before DNS', () => {
  assert.deepEqual(literalAddress('127.0.0.1'), { address: '127.0.0.1', family: 4 })
  assert.deepEqual(literalAddress('[2001:4860:4860::8888]'), { address: '2001:4860:4860::8888', family: 6 })
  assert.equal(literalAddress('example.com'), undefined)
})

test('same-origin redirects compare normalized host, scheme, and port', () => {
  assert.equal(isSameOrigin(new URL('https://Example.com./a'), new URL('https://example.com/b')), true)
  assert.equal(isSameOrigin(new URL('https://example.com:444/a'), new URL('https://example.com/b')), false)
  assert.equal(isSameOrigin(new URL('http://example.com/a'), new URL('https://example.com/a')), false)
})
