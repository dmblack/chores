// Reset a person's password from the NUC's terminal, e.g. when the only
// grown-up is locked out.
//
//   npm run reset-password <username>              (add -- --sign-out to end their sessions)
//
// Prompts twice for the new password (not shown on screen). --sign-out also
// ends that person's existing sessions on every iPad. Uses DB_PATH like the
// server (default ./data/chores.db). The change is recorded in the event log.
// Safe to run while the server is running.

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { openDb } from '../server/db.js';
import { createStore } from '../server/store.js';
import { hashSecret } from '../server/passwords.js';
import { checkPassword } from '../server/auth.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = resolve(process.env.DB_PATH ?? join(root, 'data', 'chores.db'));
const args = process.argv.slice(2);
const signOut = args.includes('--sign-out');
const username = args.find((a) => !a.startsWith('--'));

function fail(message) {
  console.error(message);
  process.exit(1);
}

// Piped input (scripts, tests): read lines. A terminal: read keys without echo.
const piped = !process.stdin.isTTY;
const lines = piped ? createInterface({ input: process.stdin })[Symbol.asyncIterator]() : null;

async function askHidden(prompt) {
  if (piped) {
    const { value, done } = await lines.next();
    return done ? '' : value;
  }
  // Start reading before switching echo off: the first resume() can reset the
  // terminal mode, which would show the password. Prompt only once echo is off.
  process.stdin.setEncoding('utf8');
  process.stdin.resume();
  process.stdin.setRawMode(true);
  process.stdout.write(prompt);
  return new Promise((resolveAnswer) => {
    let value = '';
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write('\n');
    };
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n') return finish(), resolveAnswer(value);
        if (ch === '\u0003') return finish(), process.exit(130); // Ctrl+C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else if (ch >= ' ') value += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

if (!existsSync(dbPath)) fail(`No database at ${dbPath}. Set DB_PATH to the server's database file.`);
const db = openDb(dbPath);
const users = db.prepare('SELECT username, nickname, role, active FROM users ORDER BY role, username').all();
const list = () =>
  users.map((u) => `  ${u.username}  (${u.nickname}, ${u.role === 'grownup' ? 'grown-up' : 'kid'}${u.active ? '' : ', switched off'})`).join('\n');

if (!username) fail(`Usage: npm run reset-password <username>   (add -- --sign-out to also sign them out everywhere)\n\nPeople:\n${list()}`);
const user = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
if (!user) fail(`No one with username "${username}". People:\n${list()}`);

const password = await askHidden(`New password for ${user.nickname} (${user.username}): `);
const problem = checkPassword(password);
if (problem) fail(problem);
if ((await askHidden('Same password again: ')) !== password) fail('The passwords don’t match. Nothing changed.');

db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashSecret(password), user.id);
const ended = signOut ? db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id).changes : 0;
// Audit trail, like a reset from the People screen (actor: none, i.e. the server console).
createStore(db).record(null, 'user.updated', {
  userId: user.id,
  changes: { passwordReset: true, via: 'console', ...(signOut ? { signedOut: true } : {}) },
});
db.close();

console.log(`Password reset for ${user.nickname} (${user.username}).${signOut ? ` Signed out of ${ended} session(s).` : ''}`);
if (!user.active) console.log('Note: this account is switched off. A grown-up can switch it back on under People.');
