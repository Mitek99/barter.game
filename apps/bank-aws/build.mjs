// Build the Lambda bundle: esbuild resolves the TS workspace packages and
// emits one self-contained ESM file; the web client is copied alongside so
// the Lambda can serve the SPA shell, sw.js, and static assets itself
// (CloudFront serves the same files from S3 on the hot path).
import { build } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, 'dist');
const webSrc = join(here, '..', 'web');

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  entryPoints: [join(here, 'src', 'index.ts')],
  outfile: join(dist, 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: true,
  minify: false,
  // Nothing external: the AWS SDK is bundled so the deployed artifact pins
  // the exact versions we tested with.
  banner: {
    // Some AWS SDK transitive deps still use require(); give the ESM bundle a shim.
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
});

const exclude = new Set(['package.json', 'README.md']);
await mkdir(join(dist, 'assets'), { recursive: true });
await cp(webSrc, join(dist, 'assets', 'web'), {
  recursive: true,
  filter: (src) => !exclude.has(src.split('/').pop() ?? ''),
});

console.log('built dist/index.mjs + dist/assets/web');
