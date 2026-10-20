import type { UserConfig } from 'tsdown'

/** Stable plugin id; also the browser-module id the client loader keys on. */
const PLUGIN_ID = 'dsh-session-handoff'

/**
 * Modules the DSH host provides to the browser half at runtime.
 *
 * Everything in `src/client` imports DSH packages type-only, so they erase at
 * build time; `react` / `react/jsx-runtime` are the only real browser
 * requirements. Keeping this list explicit is the guardrail that prevents a
 * stray value import from being inlined into the client bundle.
 */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-locale/client',
] as const

/** Host packages resolved from the profile, never inlined into lib/. */
const HOST_EXTERNALS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-host-webserver',
  '@deepseek-ai/schemastery',
] as const

export default [
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: true,
    clean: true,
    deps: { neverBundle: [...HOST_EXTERNALS] },
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    dts: false,
    clean: false,
    deps: { neverBundle: [...CLIENT_EXTERNALS] },
    outputOptions: {
      entryFileNames: 'client.js',
      /*
       * The exact envelope the DSH browser module loader expects: the bundle
       * publishes itself under the package name and receives the host's
       * `require` for the externals above. `id` must equal the package name
       * because the loader looks the factory up by that key.
       */
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
] satisfies UserConfig[]
