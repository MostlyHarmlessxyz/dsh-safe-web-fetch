# dsh-safe-web-fetch

`dsh-safe-web-fetch` is a public-only HTTP(S) `WebFetchProvider` for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). It plugs into DSH's existing `ctx.web` capability and does not replace the model-facing `web_fetch` tool.

The package is deliberately conservative: it refuses non-global destination addresses before opening a socket, pins each request hop to the addresses that were checked, follows only same-origin redirects, and bounds time and response size.

中文说明见 [README.zh.md](README.zh.md)。

The published peer range supports DSH `0.1.0-rc.5` through the `0.1.x`
line (and Cordis `4.x`). Test the exact DSH build you deploy; DSH is still a
developer preview and may introduce breaking seam changes between releases.

## Install into a DSH profile

The package ships a `dsh.bundle` manifest. DSH therefore installs the dependency and adds its configuration layer in one command:

```sh
dsh plugin --profile safe add dsh-safe-web-fetch@next
dsh --profile safe --dump-config
```

The bundle adds the provider as `safe-http`, selects it in the `web` seam, and enables the existing `dsh-tool-web` fetch surface. Search remains pinned to the base bundle's `deepseek-official` provider.

The first canary is published under the `next` dist-tag. Pin an exact version in a production profile after reviewing the changelog:

```sh
dsh plugin --profile production add dsh-safe-web-fetch@0.1.0-next.0
```

You can also install a trusted, pinned Git revision:

```sh
dsh plugin --profile safe add github:MostlyHarmlessxyz/dsh-safe-web-fetch#<commit-sha>
```

Git installs build from source with `prepare`. pnpm 10+ may require an explicit profile `allowBuilds` entry. Treat that as permission to execute the package's install-time build; use the npm tarball when you do not want source build scripts.

## What the provider enforces

Before a connection is made, every URL is checked for:

- `http:` or `https:` only, no URL credentials, and a bounded URL length;
- exact host allow/deny policy (`*.example.com` explicitly means subdomains);
- literal IP classification and DNS resolution of every A/AAAA answer;
- fail-closed handling for mixed DNS answers;
- IANA special-purpose, private, loopback, link-local, multicast, benchmarking, documentation, mapped, transitional, and other non-unicast ranges;
- a validated destination address set passed to an Undici DNS interceptor that rewrites the socket origin while retaining the original `Host` header and TLS SNI.

Each redirect is resolved and checked again. Cross-origin redirects are rejected, even when the target is public; callers can start a separate fetch after making a new policy decision. A fresh dispatcher is used for each hop, and ambient proxy environment variables are not consulted by this transport.

Successful responses are limited to textual media types (`text/*`, HTML, JSON, and XML), capped by bytes and decoded characters, and returned in DSH's stable `{ url, statusCode, body, truncated }` shape. Cookies, authorization headers, browser storage, and request bodies are never added.

## Configuration

The bundle defaults are intentionally bounded:

| Option | Default | Hard ceiling / meaning |
| --- | ---: | --- |
| `maxUrlLength` | `2048` | `16384` characters |
| `maxResponseBytes` | `5000000` | `100000000` bytes |
| `maxBodyChars` | `100000` | `10000000` decoded characters |
| `timeoutMs` | `30000` | Node's timer maximum |
| `maxRedirects` | `5` | `20` same-origin hops |
| `maxConcurrentRequests` | `16` | `128` active fetches per provider |
| `allowHosts` | `[]` | exact names; use `*.name` for subdomains |
| `denyHosts` | `[]` | deny wins over allow |
| `userAgent` | package UA | CR/LF is rejected |

To override the plugin row in a profile, restate the complete config object (DSH patches replace config rather than deep-merging it):

```yaml
- id: safe-web-fetch
  name: dsh-safe-web-fetch
  config:
    maxUrlLength: 4096
    maxResponseBytes: 10000000
    maxBodyChars: 200000
    timeoutMs: 30000
    maxRedirects: 3
    maxConcurrentRequests: 8
    allowHosts:
      - '*.docs.example.com'
    denyHosts: []
    userAgent: my-company-dsh-fetch/1.0
```

If you do not use the bundle, mount the function plugin yourself and set `fetchProvider: safe-http` on the `web` row. Do not leave both the official `http` provider and `safe-http` auto-selected without an explicit provider id: DSH correctly reports `WEB_PROVIDER_AMBIGUOUS` in that situation.

## Error codes

The provider uses DSH's open `WebError.code` contract. Important codes include:

`WEB_PRIVATE_ADDRESS_BLOCKED`, `WEB_DNS_RESOLUTION_FAILED`, `WEB_HOST_NOT_ALLOWED`, `WEB_REDIRECT_BLOCKED`, `WEB_FETCH_TOO_LARGE`, `WEB_FETCH_TIMEOUT`, `WEB_FETCH_CONCURRENCY_LIMIT`, `WEB_ABORTED`, and `WEB_UNSUPPORTED_CONTENT_TYPE`.

## Threat model and known limitations

This is a deployment policy layer, not a proof that arbitrary network code is safe.

- The default transport connects directly through an isolated Undici dispatcher. A caller that supplies a custom `TransportFactory` or resolver can intentionally bypass those guarantees; the test seam is not a production configuration surface.
- DNS answers are validated as a set and the actual dispatcher destination is rewritten to a validated address. Resolver calls supplied by third parties cannot always be cancelled at the OS level; the provider races them against its deadline and caps concurrent requests, but a misbehaving resolver may continue work briefly after the caller receives a timeout.
- Every redirect is re-resolved, but the package does not follow cross-origin redirects and does not fetch arbitrary non-text resources such as PDFs.
- Public IP space can still host malicious content. The package does not provide malware scanning, content sanitization, prompt-injection detection, or an approval UI.
- HTTPS certificate validation remains Undici/Node's responsibility. Hostname/SNI and the original `Host` header are preserved while the socket is pinned.
- The policy intentionally fails closed for address families and special-purpose ranges that are not globally routable. The address-range table is supplied by `ipaddr.js` and should be upgraded deliberately, with regression tests, rather than edited ad hoc.

If you need a zero-trust egress gateway, organization allowlists, audit events, or proxy-mediated access, put that control in a reviewed network boundary and use this provider as an additional local check.

## Development

Requirements: Node `^22.19.0` or `>=24.0.0`, pnpm 11, and a DSH-compatible package set.

```sh
pnpm install
./node_modules/.bin/tsc -p tsconfig.json
node --test --import=tsx tests/*.test.ts
npm pack --dry-run
```

The test suite includes address-range vectors, malformed DNS answers, resolver cancellation, redirect revalidation, body limits, lifecycle disposal, and a real local HTTP server proving that the transport connects to the supplied IP while retaining the URL host header.

## Release channels

Releases are built from the committed source on GitHub. The package uses normal semver independent of DSH's shared internal release family. Canary versions use `npm publish --tag next`; stable versions move to `latest` only after the packed-tarball and DSH profile smoke tests pass. The publish workflow is designed for npm Trusted Publishing (OIDC), not a long-lived npm token.

## License

MIT. See [LICENSE](LICENSE).
