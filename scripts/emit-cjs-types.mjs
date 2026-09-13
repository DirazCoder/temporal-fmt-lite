import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST_DIR = fileURLToPath(new URL('../dist/', import.meta.url));

const RELATIVE_JS_IMPORT = /((?:from\s+|import\s*\()['"])(\.\.?\/[^'"]+)\.js(['"])/g;

async function main() {
  const entries = await readdir(DIST_DIR);
  const declarationFiles = entries.filter((name) => name.endsWith('.d.ts'));

  if (declarationFiles.length === 0) {
    throw new Error(`emit-cjs-types: no .d.ts files found in ${DIST_DIR} — did the tsc build step run first?`);
  }

  for (const name of declarationFiles) {
    const source = await readFile(join(DIST_DIR, name), 'utf8');
    const rewritten = source.replace(RELATIVE_JS_IMPORT, '$1$2.cjs$3');
    const cjsName = name.replace(/\.d\.ts$/, '.d.cts');
    await writeFile(join(DIST_DIR, cjsName), rewritten);
  }

  console.log(`emit-cjs-types: wrote ${declarationFiles.length} .d.cts file(s) alongside their .d.ts counterparts`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
