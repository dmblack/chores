/**
 * Test and cross-compile the loopback signing helper with a pinned official Go
 * toolchain. No host Go installation, AWS credentials or cloud access is used.
 * Reusable compiler/module caches remain outside the distributable signer tree.
 * @module scripts/build-signer
 */
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile, chmod } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';

/** @type {string} Official Go 1.27.4 Bookworm toolchain, including the race detector's compiler. */
const IMAGE = 'golang@sha256:4fa7c968ba93f1635670522dbb01a2c78150443e1385746924566079f36570ea';
/** @type {string} Repository root resolved independently of the caller's working directory. */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** @type {string} Directory that contains only the final binaries and verification metadata. */
const OUTPUT = join(ROOT, '.deploy', 'signer');
/** @type {function} Shell-free command execution for owned-container cleanup. */
const execute = promisify(execFile);
/** @type {string} Unique build-container name used for bounded signal cleanup. */
const container = `chores-signer-build-${randomUUID()}`;
/** @type {string|null} Unpublished build directory, removed on failure. */
let staging = null;
/** @type {import('node:child_process').ChildProcess|null} Active Docker CLI child. */
let child = null;
/** @type {Promise<void>|null} Idempotent temporary-resource cleanup operation. */
let cleaning = null;

/**
 * Remove only this invocation's build container and unpublished files.
 * @returns {Promise<void>} Completion of best-effort cleanup.
 */
function cleanup() {
  cleaning ??= (async () => {
    child?.kill('SIGTERM');
    await execute('docker', ['rm', '--force', container], { timeout: 15_000 }).catch(() => {});
    if (staging) await rm(staging, { recursive: true, force: true });
  })();
  return cleaning;
}

/**
 * Run the pinned compiler with literal mount arguments and no inherited AWS environment.
 * @param {string} buildCache - Reusable local Go compiler cache.
 * @param {string} moduleCache - Reusable verified Go module cache.
 * @returns {Promise<void>} Completion after tests and both static builds succeed.
 */
async function compile(buildCache, moduleCache) {
  const args = ['run', '--rm', '--name', container,
    '--mount', `type=bind,source=${join(ROOT, 'deploy', 'aws', 'signer')},target=/src,readonly`,
    '--mount', `type=bind,source=${staging},target=/out`,
    '--mount', `type=bind,source=${buildCache},target=/cache/build`,
    '--mount', `type=bind,source=${moduleCache},target=/cache/mod`,
    '--workdir', '/src',
    '--env', 'GOTOOLCHAIN=local', '--env', 'GOCACHE=/cache/build', '--env', 'GOMODCACHE=/cache/mod',
    '--env', 'GOPATH=/tmp/go', '--env', 'GOMAXPROCS=2', '--env', 'GOFLAGS=-mod=readonly -p=2'];
  if (process.getuid && process.getgid) args.push('--user', `${process.getuid()}:${process.getgid()}`);
  // This script is fixed compiler code; no user-provided values are evaluated by the shell.
  args.push(IMAGE, '/bin/sh', '-c', [
    'set -eu',
    'go mod download',
    'go mod verify',
    'go vet ./...',
    'CGO_ENABLED=1 go test -race -count=1 -v ./...',
    'CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/linux-amd64/chores-signer .',
    'CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o /out/linux-arm64/chores-signer .',
  ].join('\n'));
  child = spawn('docker', args, { stdio: 'inherit' });
  await new Promise((accept, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? accept() : reject(new Error(`Signer compiler exited with status ${code ?? 1}.`)));
  });
  child = null;
}

/**
 * Publish deterministic binaries, checksums and metadata after all checks pass.
 * @returns {Promise<void>} Completion of the verified static release build.
 */
async function main() {
  const work = join(ROOT, '.deploy');
  await mkdir(work, { recursive: true, mode: 0o700 });
  const buildCache = join(work, '.signer-go-build');
  const moduleCache = join(work, '.signer-go-mod');
  await Promise.all([mkdir(buildCache, { recursive: true }), mkdir(moduleCache, { recursive: true })]);
  staging = await mkdtemp(join(work, '.signer-build-'));
  for (const architecture of ['amd64', 'arm64']) await mkdir(join(staging, `linux-${architecture}`));
  await compile(buildCache, moduleCache);
  const artifacts = [];
  for (const architecture of ['amd64', 'arm64']) {
    const path = `linux-${architecture}/chores-signer`;
    const file = join(staging, path);
    const bytes = await readFile(file);
    // ELF machine identifiers verify that the cross-compiled outputs were not swapped.
    if (bytes.subarray(0, 4).toString('hex') !== '7f454c46' || bytes[4] !== 2 ||
        bytes.readUInt16LE(18) !== (architecture === 'amd64' ? 62 : 183)) throw new Error(`Invalid Linux ${architecture} executable.`);
    await chmod(file, 0o755);
    artifacts.push({ architecture, path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const manifest = { schemaVersion: 1, builder: IMAGE, goVersion: '1.27.4', static: true, raceTests: true, artifacts };
  await writeFile(join(staging, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(staging, 'SHA256SUMS'), `${artifacts.map(({ path, sha256 }) => `${sha256}  ${path}`).join('\n')}\n`);
  await rm(OUTPUT, { recursive: true, force: true });
  await rename(staging, OUTPUT);
  staging = null;
  console.log('Signer tests passed with the race detector; static Linux amd64 and arm64 binaries are in .deploy/signer/.');
}

// Signal cleanup never installs a service or modifies unrelated containers or files.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => { await cleanup(); process.exit(signal === 'SIGINT' ? 130 : 143); });
}

try { await main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
finally { await cleanup(); }
