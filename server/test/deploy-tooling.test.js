/**
 * Offline tests for release integrity, private parameters and repeatable deploys.
 * AWS CLI and HTTPS are injected; these tests never contact AWS.
 * @module test/deploy-tooling
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PassThrough, Readable } from 'node:stream';
import { deployAws, deploymentOptions } from '../../scripts/deploy-aws.js';
import { bootstrapDeployment, createPrompter } from '../../scripts/bootstrap-deployment.js';

/**
 * Provide a disposable code bundle and an in-memory CloudFormation/S3 simulator.
 * @param {object} t - Test cleanup context.
 * @returns {object} Local fixture and safe simulated AWS runner.
 */
function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'chores-deploy-tool-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(join(cwd, '.deploy'));
  cpSync(fileURLToPath(new URL('../../deploy/aws', import.meta.url)), join(cwd, 'deploy', 'aws'), { recursive: true });
  const artifact = Buffer.from('Simulated code ZIP; actual ZIP compatibility is covered by the container smoke test.');
  writeFileSync(join(cwd, '.deploy', 'chores-aws.zip'), artifact);
  writeFileSync(join(cwd, '.deploy', 'manifest.json'), JSON.stringify({ sha256: createHash('sha256').update(artifact).digest('hex') }));
  const stacks = new Map();
  const commands = [];
  let object;
  let revision = 0;
  /** Simulate one CLI command and inspect private parameter files while they exist. */
  function execute(command, args) {
    assert.equal(command, 'aws');
    commands.push([...args]);
    const value = (flag) => args[args.indexOf(flag) + 1];
    const operation = `${args[0]} ${args[1]}`;
    if (operation === 'sts get-caller-identity') return JSON.stringify({ Account: '123456789012' });
    if (operation === 'cloudformation validate-template' || args[1] === 'wait') return '';
    const name = value('--stack-name');
    if (operation === 'cloudformation describe-stacks') {
      if (!stacks.has(name)) throw Object.assign(new Error('Missing stack'), { stderr: `Stack ${name} does not exist` });
      return JSON.stringify({ Stacks: [stacks.get(name)] });
    }
    if (operation === 'cloudformation create-stack' || operation === 'cloudformation update-stack') {
      const parameters = JSON.parse(readFileSync(value('--parameters').slice(7), 'utf8'));
      assert.equal(statSync(value('--parameters').slice(7)).mode & 0o777, 0o600);
      const old = stacks.get(name);
      const resolved = parameters.map((entry) => entry.UsePreviousValue ? old.Parameters.find((prior) => prior.ParameterKey === entry.ParameterKey) : entry);
      const map = Object.fromEntries(resolved.map((entry) => [entry.ParameterKey, entry.ParameterValue]));
      const rollback = args.includes('--use-previous-template');
      const results = name.endsWith('-artifacts') ? { CodeBucket: 'chores-test-artifacts' } : {
        EndpointHostname: 'example.shard.lambda-web.us-west-2.on.aws', EndpointUrl: 'https://example.shard.lambda-web.us-west-2.on.aws',
        CurrentRevisionId: rollback ? old.Outputs.find((entry) => entry.OutputKey === 'CurrentRevisionId').OutputValue : `revision-${++revision}`,
        ServingRevisionId: map.RollbackRevisionId || `revision-${revision}`, DynamoDBTable: 'chores-test-table',
        ApplicationLogGroup: '/aws/lambda/web/chores-tasks', RegionalLogGroup: '/aws/lambda/web/chores-tasks.local' };
      stacks.set(name, { StackName: name, StackStatus: 'CREATE_COMPLETE', Parameters: resolved,
        Outputs: Object.entries(results).map(([OutputKey, OutputValue]) => ({ OutputKey, OutputValue })) });
      return JSON.stringify({ StackId: name });
    }
    if (operation === 's3api head-object') {
      if (!object) throw Object.assign(new Error('Not found'), { stderr: 'An error occurred (404) when calling HeadObject: Not Found' });
      return JSON.stringify(object);
    }
    if (operation === 's3api put-object') {
      object = { VersionId: 'version-one', Metadata: { sha256: value('--metadata').slice('sha256='.length) } };
      return JSON.stringify(object);
    }
    throw new Error(`Unexpected simulated AWS operation: ${operation}`);
  }
  return { cwd, stacks, commands, execute };
}

/** Public target validation catches accidental origins and invalid household clocks. */
test('deployment arguments require an explicit public host and valid timezone', () => {
  assert.throws(() => deploymentOptions([]), /--hostname/);
  assert.throws(() => deploymentOptions(['--hostname', 'https://tasks.fortheherd.net']), /--hostname/);
  assert.throws(() => deploymentOptions(['--hostname', 'tasks.fortheherd.net', '--timezone', 'Invalid/Clock']), /timezone/);
  assert.throws(() => deploymentOptions(['--hostname', 'tasks.fortheherd.net', '--stack', 'a']), /2–54/);
  assert.throws(() => deploymentOptions(['--hostname', 'tasks.fortheherd.net', '--stack', 'chores-']), /2–54/);
  assert.equal(deploymentOptions(['--hostname', 'tasks.fortheherd.net']).timezone, 'Australia/Melbourne');
});

/** New deployment, update and rollback preserve private credentials and exact code versions. */
test('CloudShell deployment uses private parameter files, pinned code and stable secrets', async (t) => {
  const h = fixture(t);
  const logs = [];
  const args = ['--hostname', 'tasks.fortheherd.net'];
  const services = { ...h, output: (message) => logs.push(message), fetch: async () => new Response('{"needsSetup":true}') };
  const first = await deployAws(args, services);
  const secrets = JSON.parse(readFileSync(join(h.cwd, '.deploy', 'secrets.json'), 'utf8'));
  assert.equal(first.servingRevisionId, 'revision-1');
  assert.equal(first.timezone, 'Australia/Melbourne');
  assert.equal(h.stacks.get('chores-tasks').Parameters.find((entry) => entry.ParameterKey === 'CodeVersion').ParameterValue, 'version-one');
  assert.equal(statSync(join(h.cwd, '.deploy', 'haproxy.generated.cfg')).mode & 0o777, 0o600);
  assert.equal(statSync(join(h.cwd, '.deploy', 'secrets.json')).mode & 0o777, 0o600);
  assert.ok(readFileSync(join(h.cwd, '.deploy', 'haproxy.generated.cfg'), 'utf8').includes(secrets.originSecret));
  const second = await deployAws(args, services);
  assert.equal(second.previousRevisionId, 'revision-1');
  assert.equal(h.commands.filter((command) => command[0] === 's3api' && command[1] === 'put-object').length, 1);
  assert.deepEqual(JSON.parse(readFileSync(join(h.cwd, '.deploy', 'secrets.json'), 'utf8')), secrets);
  const rolledBack = await deployAws([...args, '--rollback-revision', 'revision-1'], services);
  assert.equal(rolledBack.servingRevisionId, 'revision-1');
  assert.ok(h.commands.some((command) => command.includes('--use-previous-template')));
  assert.equal(readdirSync(join(h.cwd, '.deploy')).some((name) => name.startsWith('parameters-')), false);
  for (const secret of [secrets.originSecret, secrets.bootstrapToken]) {
    assert.equal(JSON.stringify(h.commands).includes(secret), false);
    assert.equal(logs.join('\n').includes(secret), false);
  }
});

/** Modified release bytes are rejected before provisioning any stack. */
test('deployment rejects a code archive whose integrity manifest does not match', async (t) => {
  const h = fixture(t);
  writeFileSync(join(h.cwd, '.deploy', 'chores-aws.zip'), 'Modified archive');
  await assert.rejects(deployAws(['--hostname', 'tasks.fortheherd.net'], { ...h, output: () => {} }), /does not match manifest/);
  assert.equal(h.stacks.size, 0);
});

/** Buffered setup input survives status checks and no credential or cookie is printed. */
test('bootstrap consumes piped answers and never persists or prints the session', async (t) => {
  const h = fixture(t);
  await deployAws(['--hostname', 'tasks.fortheherd.net'], { ...h, output: () => {}, fetch: async () => new Response('{"needsSetup":true}') });
  const input = Readable.from(['parent\nParent\n1980-01-01\nsecret-password\nsecret-password\n']);
  const output = new PassThrough();
  let printed = '';
  output.on('data', (chunk) => { printed += chunk; });
  let submitted;
  const result = await bootstrapDeployment({ cwd: h.cwd, output, prompter: createPrompter({ input, output }), fetchImpl: async (url, options) => {
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/status')) return new Response('{"needsSetup":true}');
    submitted = JSON.parse(options.body);
    return new Response('{"ok":true}', { headers: { 'Set-Cookie': 'sid=private-session; Secure; HttpOnly' } });
  } });
  assert.equal(result.created, true);
  assert.equal(submitted.username, 'parent');
  assert.equal(submitted.password, 'secret-password');
  assert.equal(printed.includes('secret-password'), false);
  assert.equal(printed.includes('private-session'), false);
  assert.equal(existsSync(resolve(h.cwd, '.deploy', 'session.json')), false);
});
