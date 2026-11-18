/**
 * Build a reproducible DynamoDB-only Lambda Web Function archive and a separate
 * secret-free CloudShell upload bundle. The local app keeps SQLite support.
 * @module scripts/package-aws
 */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, '.deploy');
const stage = join(output, 'package');
const cloud = join(output, 'cloudshell');
const epoch = new Date('2000-01-01T00:00:00Z');

/**
 * Execute a local build command without interpreting arguments through a shell.
 * @param {string} command - Executable name.
 * @param {string[]} args - Literal process arguments.
 * @param {object} [options] - Working directory, stdin and output overrides.
 * @returns {import('node:child_process').SpawnSyncReturns<string>} Completed process.
 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { cwd: root, encoding: 'utf8', stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} failed with exit status ${result.status}.`);
  return result;
}

/**
 * Enumerate package files deterministically without following symbolic links.
 * @param {string} directory - Root to enumerate.
 * @param {string} [prefix] - Relative directory within the archive.
 * @returns {string[]} Sorted archive file paths.
 */
function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
    .flatMap((entry) => {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) return [];
      return entry.isDirectory() ? files(directory, relative) : [relative];
    });
}

/**
 * Normalize archive metadata and zip files in stable order, excluding host extras.
 * @param {string} directory - Source tree.
 * @param {string} archive - Absolute output zip path.
 * @returns {number} Total uncompressed file bytes.
 */
function archive(directory, archive) {
  const paths = files(directory);
  let bytes = 0;
  for (const path of paths) {
    const file = join(directory, path);
    chmodSync(file, 0o644);
    utimesSync(file, epoch, epoch);
    bytes += statSync(file).size;
  }
  if (bytes > 512 * 1024 * 1024) throw new Error('The package exceeds Lambda Web Functions’ 512 MB uncompressed limit.');
  rmSync(archive, { force: true });
  run('zip', ['-X', '-q', archive, '-@'], { cwd: directory, stdio: 'pipe', input: `${paths.join('\n')}\n`, env: { ...process.env, TZ: 'UTC' } });
  chmodSync(archive, 0o600);
  return bytes;
}

// Only named generated directories are replaced; household data and secrets are never copied.
try {
  run('zip', ['-v'], { stdio: 'pipe' });
  run('npm', ['run', 'build']);
  mkdirSync(output, { recursive: true, mode: 0o700 });
  for (const directory of [stage, cloud]) { rmSync(directory, { recursive: true, force: true }); mkdirSync(directory, { recursive: true }); }
  for (const directory of ['server', 'shared']) {
    cpSync(join(root, directory), join(stage, directory), { recursive: true,
      filter: (source) => !source.split(/[\\/]/).includes('test') });
  }
  cpSync(join(root, 'client', 'dist'), join(stage, 'client', 'dist'), { recursive: true });
  for (const name of ['package.json', 'package-lock.json']) cpSync(join(root, name), join(stage, name));
  // DynamoDB uses only JavaScript dependencies. better-sqlite3 loads its addon
  // only when SQLite opens; the managed runtime is forced to DynamoDB before
  // building the app, so no host-native SQLite addon is built or shipped.
  run('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: stage });
  // This package version includes prebuilt SQLite addons even with install
  // scripts disabled. Remove those unused binaries from the cloud-only archive.
  rmSync(join(stage, 'node_modules', 'better-sqlite3', 'prebuilds'), { recursive: true, force: true });
  if (files(stage).some((path) => path.endsWith('.node'))) throw new Error('Unexpected native addon in the architecture-independent DynamoDB package.');
  const artifact = join(output, 'chores-aws.zip');
  const uncompressedBytes = archive(stage, artifact);
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  const commit = run('git', ['rev-parse', 'HEAD'], { stdio: 'pipe' }).stdout.trim();
  const dirty = !!run('git', ['status', '--porcelain'], { stdio: 'pipe' }).stdout.trim();
  const manifest = { sha256, commit, dirty, runtime: 'nodejs24.x', backend: 'dynamodb',
    architecture: 'arm64', nativeAddons: false, uncompressedBytes };
  writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  mkdirSync(join(cloud, '.deploy'), { recursive: true });
  mkdirSync(join(cloud, 'scripts'), { recursive: true });
  mkdirSync(join(cloud, 'deploy', 'aws'), { recursive: true });
  for (const name of ['chores-aws.zip', 'manifest.json']) cpSync(join(output, name), join(cloud, '.deploy', name));
  for (const name of ['deploy-aws.js', 'bootstrap-deployment.js']) {
    if (!existsSync(join(root, 'scripts', name))) throw new Error(`Missing deployment script: ${name}`);
    cpSync(join(root, 'scripts', name), join(cloud, 'scripts', name));
  }
  for (const name of ['artifacts.yaml', 'application.yaml', 'haproxy.cfg.example', 'README.md']) {
    cpSync(join(root, 'deploy', 'aws', name), join(cloud, 'deploy', 'aws', name));
  }
  writeFileSync(join(cloud, 'package.json'), '{"private":true,"type":"module"}\n');
  archive(cloud, join(output, 'chores-cloudshell.zip'));
  console.log(`Built .deploy/chores-aws.zip (${uncompressedBytes} uncompressed bytes, SHA-256 ${sha256}).`);
  console.log('Upload .deploy/chores-cloudshell.zip to AWS CloudShell; it contains no deployment secrets.');
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
