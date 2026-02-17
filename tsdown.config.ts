import { defineConfig } from 'tsdown'

export default defineConfig({
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    external: ['cloudflare:workers'],
    dts: true,
    sourcemap: true,
    clean: true,

    // ES2023 includes Explicit Resource Management. Note that the library does not actually use
    // the `using` keyword, but does use `Symbol.dispose`, and automatically polyfills it if it is
    // missing.
    target: 'es2023',

    // Works in browsers, Node, and Cloudflare Workers
    platform: 'neutral',

    treeshake: true,
    minify: false, // Keep readable for debugging

    exports: true, // enable to auto gen "exports" in package.json
});
