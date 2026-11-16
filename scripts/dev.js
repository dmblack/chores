// Development runners.
//   npm run dev         API (reloads on change) + Vite dev server with hot reload.
//                       Open http://localhost:5173 on this computer.
//   npm run dev:device  API + the built app, rebuilt on every save.
//                       Open http://<this computer>:3000 on a phone or iPad.
//
// Why two: the Vite dev server sends unminified development builds in dozens of
// files (about 50 MB of JavaScript memory), which is slow on a phone over a VPN
// and heavy enough that iOS Safari may discard and reload the tab. The built
// app is 6 files and about 5 MB. It has no hot reload: after a save, refresh.
import { spawn, spawnSync } from 'node:child_process';

const device = process.argv.includes('--device');
const npm = (args, opts) => [process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', ...args], { stdio: 'inherit', ...opts }];

if (device) {
  // The server only serves client/dist if it exists when it starts.
  const first = spawnSync(...npm(['build', '--', '--logLevel', 'warn']));
  if (first.status !== 0) process.exit(first.status ?? 1);
}

const run = (script) => spawn(...npm([script], { shell: process.platform === 'win32' }));
const children = device ? [run('dev:server'), run('build:watch')] : [run('dev:server'), run('dev:client')];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (code) stop(); });
