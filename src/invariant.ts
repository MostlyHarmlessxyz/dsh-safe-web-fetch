/** Optional package-owned invariant companion. The provider has no durable
 * cross-event invariant; this entry exists for loader diagnostics symmetry. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

export const name = 'safe-web-fetch-invariant'
export const inject = ['invariants']
const PACKAGE_NAME = 'dsh-safe-web-fetch'
const install: InvariantInstaller = () => undefined

export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
