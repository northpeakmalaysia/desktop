#!/usr/bin/env node
/**
 * @swarmai/desktop — closed-source bundler.
 *
 * Same pattern as @swarmai/cli-tools/scripts/bundle.mjs. See that file's
 * header for the architecture rationale.
 *
 * Plugin-specific notes:
 *   - No runtime deps (uses `node:*` builtins + peer-dep `@swarmai/tools`
 *     `register()`); externals list is just `@swarmai/*`.
 *   - desktop-*.ts files use `import { register } from '@swarmai/tools'` —
 *     that import stays external so the plugin lands in the host's
 *     registry instance, not a copy of one.
 *   - The Android side-effect file `desktop-android.ts` registers tools
 *     conditionally on `IS_ANDROID`; minification preserves the gate.
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(__dirname, '..');
const OUT = join(PLUGIN_ROOT, 'dist');

console.log(`[bundle] @swarmai/desktop`);
console.log(`[bundle] root: ${PLUGIN_ROOT}`);
console.log(`[bundle] out:  ${OUT}`);

if (existsSync(OUT)) rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const EXTERNAL = [
  '@swarmai/*',
];

const t0 = Date.now();
await build({
  entryPoints: [join(PLUGIN_ROOT, 'src/index.ts')],
  bundle: true,
  minify: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  outfile: join(OUT, 'index.js'),
  external: EXTERNAL,
  absWorkingDir: PLUGIN_ROOT,
  legalComments: 'none',
  treeShaking: true,
  sourcemap: false,
});
console.log(`[bundle] esbuild done in ${Date.now() - t0}ms`);

console.log(`[bundle] tsc --emitDeclarationOnly`);
execSync('npx tsc --emitDeclarationOnly --declarationMap false --sourceMap false', {
  cwd: PLUGIN_ROOT,
  stdio: 'inherit',
});

const jsSize = statSync(join(OUT, 'index.js')).size;
console.log(`[bundle] dist/index.js = ${(jsSize / 1024).toFixed(1)} KiB`);
console.log(`[bundle] done`);
