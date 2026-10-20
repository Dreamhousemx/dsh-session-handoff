import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig({
  /*
   * Source files import each other with explicit `.ts` extensions, which is what
   * the host build (`tsdown`/`tsc` under `allowImportingTsExtensions`) requires.
   * Vite's module runner resolves a relative `.../file.ts` specifier by stripping
   * the extension first and then probing a graph that has no `.ts` entry, so it
   * reports `ERR_MODULE_NOT_FOUND` for a file Node itself imports fine. Mapping
   * the source directory to an absolute alias makes every specifier resolvable
   * without relying on Vite's extension probing.
   */
  resolve: {
    alias: [{ find: /^@src\//, replacement: `${root}src/` }],
  },
  server: {
    fs: { allow: [root] },
  },
  test: {
    include: ['tests/**/*.spec.ts', 'tests/client/**/*.spec.ts'],
    environment: 'node',
  },
})
