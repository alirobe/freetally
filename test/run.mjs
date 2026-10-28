// Builds the server image, runs it in Docker on a throwaway data directory, runs the API tests,
// then stops it. Docker rather than a native binary: on Windows each new binary trips the firewall.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const root = path.join(import.meta.dirname, '..');
const dataDir = mkdtempSync(path.join(process.env.TEST_TMP ?? tmpdir(), 'freetally-test-'));
const adminKey = 'test_admin_key_0123456789abcdefghijklmnop';
// Separate tags let several checkouts run their tests at once.
const image = process.env.TEST_IMAGE ?? 'freetally:test';

// A database in the first release's schema, so every run also checks the upgrade path.
function seedLegacyDatabase() {
  const db = new DatabaseSync(path.join(dataDir, 'freetally.db'));
  db.exec(`
    CREATE TABLE tallies (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tally_id TEXT NOT NULL REFERENCES tallies(id),
      delta INTEGER NOT NULL, total INTEGER NOT NULL, who TEXT NOT NULL,
      op_id TEXT NOT NULL, at INTEGER NOT NULL,
      UNIQUE (tally_id, op_id)
    );
    INSERT INTO tallies VALUES ('legacy2345', 'Legacy tally', 1700000000000);
    INSERT INTO entries (tally_id, delta, total, who, op_id, at) VALUES
      ('legacy2345', 5, 5, 'Old Sam', 'legacy-op-1', 1700000000001),
      ('legacy2345', -2, 3, 'Old Jo', 'legacy-op-2', 1700000000002);
  `);
  db.close();
}

const freePort = () =>
  new Promise((resolve) => {
    const s = createServer().listen(0, () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

const docker = (...args) => spawnSync('docker', args, { cwd: root, stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8' });

seedLegacyDatabase();
const port = await freePort();
if (spawnSync('docker', ['build', '-q', '-t', image, '.'], { cwd: root, stdio: 'inherit' }).status !== 0) process.exit(1);
const run = docker(
  'run', '-d', '--rm',
  '-p', `127.0.0.1:${port}:3000`,
  '-v', `${dataDir}:/data`,
  '-e', `ADMIN_KEY=${adminKey}`,
  // Lets the tests talk from many addresses.
  '-e', 'CLIENT_IP_HEADER=X-Forwarded-For',
  // Shorter batching so the batching tests run in seconds; the rules are the same.
  '-e', 'BATCH_QUIET_MS=300',
  '-e', 'BATCH_MAX_WAIT_MS=1000',
  image,
);
if (run.status !== 0) process.exit(1);
const container = run.stdout.trim();

const base = `http://127.0.0.1:${port}`;
let up = false;
for (let i = 0; i < 100 && !up; i++) {
  await new Promise((r) => setTimeout(r, 100));
  up = await fetch(`${base}/healthz`).then((r) => r.ok, () => false);
}

let status = 1;
if (up) {
  const tests = spawnSync(process.execPath, ['--test', '--test-timeout=120000', '--test-reporter=spec', path.join(import.meta.dirname, 'api.test.mjs')], {
    stdio: 'inherit',
    env: { ...process.env, BASE: base, ADMIN_KEY: adminKey },
  });
  status = tests.status ?? 1;
} else {
  console.error('Server did not start');
}

if (status !== 0) spawnSync('docker', ['logs', '--tail', '20', container], { stdio: 'inherit' });
docker('stop', container);
rmSync(dataDir, { recursive: true, force: true });
process.exit(status);
