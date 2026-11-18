/** CLI coverage for the public proxy path and the independently denied unsigned AWS endpoint. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { bootstrapDeployment, createPrompter } from '../../scripts/bootstrap-deployment.js';
import { verifyDeployment } from '../../scripts/verify-deployment.js';

const ENDPOINT = 'https://example.shard.lambda-web.us-west-2.on.aws';
const PUBLIC = 'https://tasks.fortheherd.net';
const ORIGIN_SECRET = 'a'.repeat(64);
const BOOTSTRAP_TOKEN = 'b'.repeat(64);
const PASSWORD = 'test-parent-password';

/**
 * Create disposable local deployment metadata, optionally without any secret file.
 * @param {object} t - Node test cleanup owner.
 * @param {boolean} [includeSecrets] - Whether the bootstrap secret file is needed.
 * @returns {Promise<object>} Fixture root and captured safe CLI output.
 */
async function fixture(t, includeSecrets = true) {
  const cwd = await mkdtemp(join(tmpdir(), 'chores-proxy-access-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await mkdir(join(cwd, '.deploy'));
  await writeFile(join(cwd, '.deploy/deployment.json'), JSON.stringify({ endpointUrl: ENDPOINT, publicHostname: 'tasks.fortheherd.net' }));
  if (includeSecrets) await writeFile(join(cwd, '.deploy/secrets.json'), JSON.stringify({ originSecret: ORIGIN_SECRET, bootstrapToken: BOOTSTRAP_TOKEN }));
  let captured = '';
  return { cwd, output: { write(value) { captured += value; } }, text: () => captured };
}

/** The allowlisted public hostname carries both setup requests; answers remain buffered and private. */
test('bootstrap uses the public proxy and preserves hidden piped input without storing a session', async (t) => {
  const h = await fixture(t);
  const input = Readable.from([`parent\nParent\n1980-01-02\n${PASSWORD}\n${PASSWORD}\n`]);
  const calls = [];
  const result = await bootstrapDeployment({ cwd: h.cwd, output: h.output,
    prompter: createPrompter({ input, output: h.output }), fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (options.method === 'GET') {
        await new Promise((resolve) => setImmediate(resolve));
        return Response.json({ needsSetup: true });
      }
      return Response.json({ ignored: 'private-session-body' }, { headers: { 'Set-Cookie': 'sid=private-cookie' } });
    } });
  assert.deepEqual(result, { created: true, publicUrl: PUBLIC });
  assert.deepEqual(calls.map((call) => call.url), [`${PUBLIC}/api/auth/status`, `${PUBLIC}/api/auth/setup`]);
  for (const { options } of calls) {
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-app-origin-secret'], ORIGIN_SECRET);
  }
  assert.equal(calls[1].options.headers['x-bootstrap-token'], BOOTSTRAP_TOKEN);
  assert.deepEqual(JSON.parse(calls[1].options.body), { username: 'parent', nickname: 'Parent', birthDate: '1980-01-02', password: PASSWORD });
  for (const secret of [ORIGIN_SECRET, BOOTSTRAP_TOKEN, PASSWORD, 'private-session-body', 'private-cookie']) assert.equal(h.text().includes(secret), false);
  assert.deepEqual((await readdir(join(h.cwd, '.deploy'))).sort(), ['deployment.json', 'secrets.json']);
  assert.equal((await readFile(join(h.cwd, '.deploy/deployment.json'), 'utf8')).includes(PASSWORD), false);
});

/** Already-created households exit after one public GET without asking for credentials or writing. */
test('configured public deployments do not prompt or submit a setup request', async (t) => {
  const h = await fixture(t);
  let closed = false;
  const calls = [];
  const result = await bootstrapDeployment({ cwd: h.cwd, output: h.output, prompter: {
    ask() { assert.fail('Already configured households must not ask for input'); },
    close() { closed = true; },
  }, fetchImpl: async (url, options) => {
    calls.push({ url, method: options.method });
    return Response.json({ needsSetup: false });
  } });
  assert.equal(result.created, false);
  assert.equal(closed, true);
  assert.deepEqual(calls, [{ url: `${PUBLIC}/api/auth/status`, method: 'GET' }]);
});

/** A rejected network or proxy path prevents credential collection and never falls back to AWS. */
test('public bootstrap denial fails before prompts and hides the response body', async (t) => {
  const h = await fixture(t);
  let closed = false;
  let requested = 0;
  await assert.rejects(bootstrapDeployment({ cwd: h.cwd, output: h.output, prompter: {
    ask() { assert.fail('Denied networks must not be asked for credentials'); },
    close() { closed = true; },
  }, fetchImpl: async (url, options) => {
    requested += 1;
    assert.equal(url, `${PUBLIC}/api/auth/status`);
    assert.equal(options.redirect, 'error');
    return Response.json({ error: { message: 'private-error-detail' } }, { status: 403 });
  } }), /HTTP 403.*network allowlist/);
  assert.equal(requested, 1);
  assert.equal(closed, true);
  assert.equal(h.text().includes('private-error-detail'), false);
});

/** Redirect rejection cannot expose a header or an implementation-provided network error. */
test('bootstrap rejects redirects without printing a transport error containing secrets', async (t) => {
  const h = await fixture(t);
  await assert.rejects(bootstrapDeployment({ cwd: h.cwd, output: h.output, prompter: {
    ask() { assert.fail('Failed transport must not ask for credentials'); },
    close() {},
  }, fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    throw new Error(`Redirect includes ${ORIGIN_SECRET}`);
  } }), (error) => {
    assert.match(error.message, /allowlisted network/);
    assert.equal(error.message.includes(ORIGIN_SECRET), false);
    return true;
  });
});

/** The valid application secret prevents the former application-only gate from producing a false pass. */
test('verification proves unsigned AWS denial with a valid origin secret and checks public proxy access', async (t) => {
  const h = await fixture(t);
  const calls = [];
  const result = await verifyDeployment({ cwd: h.cwd, output: h.output, fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return url.startsWith(ENDPOINT) ? new Response('Denied', { status: 403 }) : Response.json({ needsSetup: true });
  } });
  assert.deepEqual(result, { directDenied: true, needsSetup: true, publicUrl: PUBLIC });
  assert.deepEqual(calls.map((call) => call.url), [`${ENDPOINT}/api/auth/status`, `${PUBLIC}/api/auth/status`]);
  for (const { options } of calls) {
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
  }
  assert.deepEqual(calls[0].options.headers, { 'x-app-origin-secret': ORIGIN_SECRET });
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[0].options.headers.authorization, undefined);
  assert.equal(calls[0].options.headers['x-bootstrap-token'], undefined);
  assert.match(h.text(), /Unsigned AWS endpoint access is denied/);
  assert.equal(h.text().includes(ORIGIN_SECRET), false);
  assert.equal(h.text().includes(BOOTSTRAP_TOKEN), false);
});

/** Any unsigned AWS result other than the expected IAM denial stops verification. */
test('verification fails when unsigned AWS access is accepted or redirected', async (t) => {
  const h = await fixture(t);
  for (const status of [200, 302, 401, 500]) {
    let requested = 0;
    await assert.rejects(verifyDeployment({ cwd: h.cwd, output: h.output, fetchImpl: async (url) => {
      requested += 1;
      assert.equal(url, `${ENDPOINT}/api/auth/status`);
      return new Response('private-response-body', { status });
    } }), /Unsigned AWS endpoint access was not denied/);
    assert.equal(requested, 1);
    assert.equal(h.text().includes('private-response-body'), false);
  }
});

/** A correct AWS denial cannot mask an inaccessible public proxy or a wrong upstream response. */
test('verification requires the public proxy to return an actual application status', async (t) => {
  const h = await fixture(t);
  for (const response of [new Response('Forbidden', { status: 403 }), Response.json({ wrong: true }), new Response('<html>Wrong service</html>')]) {
    await assert.rejects(verifyDeployment({ cwd: h.cwd, output: h.output, fetchImpl: async (url) => (
      url.startsWith(ENDPOINT) ? new Response('Denied', { status: 403 }) : response
    ) }), /Public deployment check failed|invalid setup status/);
  }
});

/** A verifier without its private origin credential cannot prove the application gate was passed. */
test('verification requires private origin credentials before making any probe', async (t) => {
  const h = await fixture(t, false);
  await assert.rejects(verifyDeployment({ cwd: h.cwd, output: h.output, fetchImpl: async () => {
    assert.fail('A missing private credential must prevent verification requests');
  } }), /Cannot read deployment configuration/);
});

/** A rejected redirect cannot expose the direct probe's private credential through diagnostics. */
test('verification rejects redirects without printing the private origin credential', async (t) => {
  const h = await fixture(t);
  await assert.rejects(verifyDeployment({ cwd: h.cwd, output: h.output, fetchImpl: async (url, options) => {
    assert.equal(url, `${ENDPOINT}/api/auth/status`);
    assert.equal(options.redirect, 'error');
    throw new Error(`Redirect error containing ${ORIGIN_SECRET}`);
  } }), (error) => {
    assert.equal(error.message.includes(ORIGIN_SECRET), false);
    assert.match(error.message, /Cannot reach/);
    return true;
  });
  assert.equal(h.text().includes(ORIGIN_SECRET), false);
});
