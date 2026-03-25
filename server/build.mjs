import { build } from 'esbuild'

await build({
  entryPoints: ['src/gateway.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'dist/gateway.mjs',
  // Inject createRequire so CJS libraries (google-auth-library etc.) can use
  // dynamic require() for Node.js built-in modules inside ESM bundle.
  // esbuild generates its own __filename/__dirname shims and a require shim,
  // but the require shim throws on dynamic require of Node built-ins (child_process etc.).
  // We override it with a real createRequire-based require.
  banner: {
    js: `import{createRequire as ___cr}from'module';var require=___cr(import.meta.url);`
  },
  external: [
    'better-sqlite3',       // native C++ addon
    'fsevents',             // macOS-only native
    'koffi',                // Windows FFI, not used on Linux
    '@silvia-odwyer/photon-node',  // native image processing
    '@mariozechner/clipboard-darwin-universal',
    '@mariozechner/clipboard-darwin-arm64',
    '@mariozechner/clipboard-linux-x64-gnu',
    'lightningcss-darwin-arm64',
    '@rolldown/binding-darwin-arm64',
  ],
})

console.log('  dist/gateway.mjs  built successfully')
