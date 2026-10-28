// Runs the server for development in Docker (a native binary trips the Windows firewall on every
// rebuild). Pages are served from public/ so edits show on reload, and the server restarts when a
// .go file changes. Data goes in ./data.
import { spawn, spawnSync } from 'node:child_process';
import { watch } from 'node:fs';
import path from 'node:path';

const root = path.join(import.meta.dirname, '..');
const port = process.env.PORT ?? '3000';
const adminKey = process.env.ADMIN_KEY ?? 'dev_admin_key_0123456789abcdefghijklmn';
const name = 'freetally-dev';

spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
const server = spawn(
  'docker',
  [
    'run', '--rm', '--name', name,
    '-p', `127.0.0.1:${port}:3000`,
    '-v', `${root}:/src`,
    // Module and build caches survive restarts, so a rebuild takes a second or two.
    '-v', 'freetally-dev-gomod:/go/pkg/mod',
    '-v', 'freetally-dev-gocache:/root/.cache/go-build',
    '-w', '/src',
    '-e', 'STATIC_DIR=/src/public',
    '-e', 'DATA_DIR=/src/data',
    '-e', `ADMIN_KEY=${adminKey}`,
    'golang:1.27-alpine',
    'go', 'run', '.',
  ],
  { stdio: 'inherit' },
);
console.log(`FreeTally: http://127.0.0.1:${port}  Admin: http://127.0.0.1:${port}/admin/${adminKey}`);

let restartTimer;
watch(root, (_, file) => {
  if (!file?.endsWith('.go')) return;
  clearTimeout(restartTimer);
  restartTimer = setTimeout(() => spawnSync('docker', ['restart', '-t', '2', name], { stdio: 'ignore' }), 300);
});

const stop = () => {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
server.on('exit', (code) => process.exit(code ?? 0));
