# Release runbook

This repository publishes the npm package and the DSH bundle from the same
tag. The package is independent of DSH's internal shared release family.

## First publication

The first package record must be created by an npm account with publish rights.
If the account has two-factor authentication enabled, npm requires a current
one-time password for this one-time bootstrap:

```sh
npm pack
npm publish dsh-safe-web-fetch-0.1.0-next.0.tgz --access public --tag next --otp=<current-otp>
```

Do not put an OTP or an npm token in Git, an issue, or a workflow file. After
the package exists, configure npm Trusted Publishing for the exact GitHub
repository and workflow filename:

```sh
npm trust github dsh-safe-web-fetch \
  --repo MostlyHarmlessxyz/dsh-safe-web-fetch \
  --file publish.yml \
  --env npm-publish \
  --allow-publish -y
```

The npm package settings and the GitHub environment must use the same names.
The workflow uses GitHub OIDC (`id-token: write`) and does not read
`NPM_TOKEN`. Use an environment approval rule for the first stable release.

## Subsequent releases

1. Update `version` and `CHANGELOG.md`.
2. Run `pnpm install --frozen-lockfile`, typecheck, tests, build, and a packed
   consumer smoke test.
3. Commit and push the change.
4. Create an immutable release tag, for example `v0.1.0-next.1`:

   ```sh
   git tag -a v0.1.0-next.1 -m 'release: v0.1.0-next.1'
   git push origin v0.1.0-next.1
   ```

The workflow selects the `next` dist-tag for prereleases and `latest` for
stable versions. Verify the result with `npm view`, `npm dist-tag ls`, and
`npm audit signatures`.

If a published version has a serious defect, deprecate that exact version
with an explanation and publish a fixed version. Routine rollback should not
use npm unpublish.
