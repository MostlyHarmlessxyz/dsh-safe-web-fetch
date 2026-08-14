# dsh-safe-web-fetch

`dsh-safe-web-fetch` gives [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) a safer way to use its `web_fetch` capability. It plugs into DSH's existing `ctx.web` service, so it works with the normal tool and profile system instead of introducing a second web-search API.

The idea is simple: a hostname must resolve to a public address before a connection is opened. Each request hop is pinned to the addresses that were checked, redirects stay on the same origin, and responses are kept within predictable size and time limits.

## Quick start

The package includes a DSH bundle, so one command installs it and adds the profile layer:

```sh
dsh plugin --profile safe add dsh-safe-web-fetch@next
dsh --profile safe --dump-config
```

The bundle registers a `safe-http` provider, enables DSH's existing `web_fetch` tool, and leaves search on the base profile's provider. For a deployment, pin the version you have tested:

```sh
dsh plugin --profile production add dsh-safe-web-fetch@0.1.0-next.0
```

You can install a reviewed Git revision instead:

```sh
dsh plugin --profile safe add github:MostlyHarmlessxyz/dsh-safe-web-fetch#<commit-sha>
```

Git installs build the package locally. If pnpm asks you to approve that build, follow the profile-specific instruction it prints; an npm package or tarball is the simpler option when you want prebuilt files.

## What it does

For every fetch, the provider:

- accepts only HTTP and HTTPS URLs without embedded credentials;
- applies optional host allow/deny lists (entries are exact; write `*.example.com` when subdomains are intended);
- checks every DNS answer, including IPv4-mapped IPv6 and special-purpose ranges, before opening a socket;
- connects through an isolated Undici dispatcher pinned to the checked address;
- rechecks every same-origin redirect and rejects cross-origin redirects;
- limits response bytes, decoded characters, redirects, concurrent requests, and total time;
- returns only text-like media types (text, HTML, JSON, and XML) in DSH's usual result shape.

It does not add cookies, authorization headers, browser state, or request bodies. A public address is not automatically trustworthy content: prompt injection, malware, and HTML sanitization remain application concerns.

## Configuration

The defaults are deliberately modest:

| Option | Default | Maximum |
| --- | ---: | ---: |
| `maxUrlLength` | `2048` | `16384` |
| `maxResponseBytes` | `5000000` | `100000000` |
| `maxBodyChars` | `100000` | `10000000` |
| `timeoutMs` | `30000` | Node timer limit |
| `maxRedirects` | `5` | `20` |
| `maxConcurrentRequests` | `16` | `128` |

`allowHosts`, `denyHosts`, and `userAgent` are also configurable. DSH replaces a row's complete config when a patch targets it, so include every value you want to keep:

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
    userAgent: my-company-fetch/1.0
```

If you mount the function plugin yourself instead of using the bundle, set `fetchProvider: safe-http` on the `web` row. When more than one provider is available, always select one by id; DSH will otherwise report `WEB_PROVIDER_AMBIGUOUS` rather than guessing.

## A note about the security boundary

The built-in resolver is raced against the request deadline, but a third-party resolver cannot always be stopped at the operating-system level. A custom resolver or transport is an extension point for tests and trusted integrations, not a way to make an untrusted network client safe.

This package deliberately follows only same-origin redirects and handles text responses. It is not an egress firewall, content scanner, approval screen, or proxy policy. For an organization-wide zero-trust network, keep those controls at the network boundary and use this provider as an additional check.

## Compatibility and development

The published peer range covers DSH `0.1.0-rc.5` through the `0.1.x` line and Cordis `4.x`. DSH is still a developer preview, so test the exact versions used by your profile.

Requires Node `^22.19.0` or `>=24.0.0` and pnpm 11:

```sh
pnpm install
pnpm run typecheck
pnpm test
pnpm run build
npm pack --dry-run
```

The tests include address-range and malformed-DNS cases, redirect revalidation, cancellation, response limits, lifecycle disposal, and a local HTTP server that verifies the socket is pinned while the original `Host` header is retained.

Release notes and the maintainer checklist live in [RELEASE.md](RELEASE.md). The project is MIT licensed.
