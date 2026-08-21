/**
 * Lets the test files import the app's TypeScript modules directly.
 *
 * The library uses extensionless relative imports, which is what the Next.js
 * bundler expects but not something Node's resolver does on its own. This hook
 * retries such a specifier with a `.ts` suffix so `node --experimental-strip-types`
 * can load `lib/` exactly as shipped, with no build step in between.
 */
export async function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && !/\.[cm]?[jt]sx?$/.test(specifier)) {
    try { return await next(specifier + '.ts', context); } catch { /* fall through */ }
  }
  return next(specifier, context);
}
