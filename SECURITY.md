# Security policy

## Scope

Security reports include SSRF bypasses, DNS-rebinding/pinning failures, unsafe redirect handling, credential leakage, response-limit bypasses, and dependency vulnerabilities that affect the published package.

The default provider is intended to be an additional local control. It is not a replacement for an egress firewall, proxy policy, or content-security review.

## Reporting

Please do not open a public issue for an unpatched bypass. Use the repository's private GitHub security-advisory flow when available, or contact the maintainers through the address listed in the repository security settings. Include:

1. the package version and DSH version;
2. Node/OS/architecture;
3. a minimal URL, resolver answer, or redirect sequence that demonstrates the issue;
4. whether the default transport or a custom test transport was used.

We will acknowledge a report within seven days and coordinate a disclosure date. Do not include real credentials or private hostnames in a report; redact them and provide a reproducible placeholder instead.

## Supported versions

The latest `latest` release and the current `next` canary receive fixes. Older versions should be upgraded before filing a report unless the issue is a regression-specific report.
