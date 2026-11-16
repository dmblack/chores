// Runs the API server (with reload) and the Vite dev server together.
//   npm run dev  ->  open http://localhost:5173
import { spawn } from 'node:child_process';

const run = (script) => spawn('npm', ['run', script], { stdio: 'inherit', shell: process.platform === 'win32' });
const children = [run('dev:server'), run('dev:client')];
const stop = () => children.forEach((c) => c.kill('SIGTERM'));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
for (const c of children) c.on('exit', (code) => { if (code) stop(); });
