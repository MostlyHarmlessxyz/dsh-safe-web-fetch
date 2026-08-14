# Contributing

1. Run the address-policy and transport tests before opening a pull request.
2. Add a regression test for every policy change, especially for a newly discovered address range or redirect form.
3. Do not add ambient cookies, authorization headers, proxy fallback, or a global dispatcher.
4. Keep the published package free of `workspace:` dependencies and verify `npm pack --dry-run` from a clean checkout.
5. Describe any change to the threat model in both README files and `SECURITY.md` when appropriate.
