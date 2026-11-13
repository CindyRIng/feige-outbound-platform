import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
function copy(src, dst) {
  if (!existsSync(src)) return;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log('copied', src, '->', dst);
}
copy('src/db/migrations', 'dist/src/db/migrations');
copy('src/upstream/login-worker.mjs', 'dist/upstream/login-worker.mjs');
