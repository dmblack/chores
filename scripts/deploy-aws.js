/**
 * Deploy versioned application code through CloudFormation using CloudShell's
 * existing AWS CLI identity. Secrets remain in private files, never CLI arguments.
 * This script also works with an explicitly configured local AWS CLI profile.
 * @module scripts/deploy-aws
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

/**
 * Parse deployment arguments without accepting unknown or incomplete options.
 * @param {string[]} args - Command-line arguments.
 * @returns {object} Validated deployment configuration.
 */
export function deploymentOptions(args) {
  const options = { region: 'us-west-2', stack: 'chores-tasks', artifact: '.deploy/chores-aws.zip', secretsFile: '.deploy/secrets.json', timezone: 'Australia/Melbourne' };
  const names = { '--hostname': 'hostname', '--region': 'region', '--stack': 'stack', '--artifact': 'artifact',
    '--secrets-file': 'secretsFile', '--ca-file': 'caFile', '--rollback-revision': 'rollbackRevision', '--timezone': 'timezone' };
  for (let i = 0; i < args.length; i += 2) {
    if (!names[args[i]] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown or incomplete option: ${args[i]}`);
    options[names[args[i]]] = args[i + 1];
  }
  if (!options.hostname || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(options.hostname) ||
      new URL(`https://${options.hostname}`).hostname !== options.hostname || options.hostname.length > 253) {
    throw new Error('Supply --hostname with your public DNS hostname, for example tasks.fortheherd.net.');
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(options.region)) throw new Error('Invalid AWS region.');
  if (!/^[A-Za-z][A-Za-z0-9-]{0,52}[A-Za-z0-9]$/.test(options.stack)) {
    throw new Error('--stack must contain 2–54 letters, numbers or dashes, begin with a letter and end with a letter or number.');
  }
  if (options.caFile && (!isAbsolute(options.caFile) || /\s/.test(options.caFile))) throw new Error('--ca-file must be an absolute HAProxy-host path without whitespace.');
  if (options.rollbackRevision && !/^[A-Za-z0-9_-]+$/.test(options.rollbackRevision)) throw new Error('Invalid rollback revision ID.');
  try { new Intl.DateTimeFormat('en', { timeZone: options.timezone }).format(); }
  catch { throw new Error('Invalid household timezone. Use an IANA name such as Australia/Melbourne.'); }
  return options;
}

/**
 * Load stable private credentials or generate them once for this deployment.
 * @param {string} file - Private credential file, excluded from the release bundle.
 * @returns {{originSecret: string, bootstrapToken: string}} Stable deployment secrets.
 */
export function deploymentSecrets(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  if (!existsSync(file)) {
    writeFileSync(file, `${JSON.stringify({ originSecret: randomBytes(32).toString('hex'), bootstrapToken: randomBytes(32).toString('hex') }, null, 2)}\n`,
      { mode: 0o600, flag: 'wx' });
  }
  chmodSync(file, 0o600);
  const secrets = JSON.parse(readFileSync(file, 'utf8'));
  if (![secrets.originSecret, secrets.bootstrapToken].every((value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value)) ||
      secrets.originSecret === secrets.bootstrapToken) throw new Error('The deployment secret file must contain two distinct 64-character hex secrets.');
  return secrets;
}

/**
 * Render the proxy excerpt while leaving an unknown host CA bundle explicit.
 * @param {string} template - Checked HAProxy configuration excerpt.
 * @param {object} values - Public host, AWS endpoint, secret and optional CA file.
 * @returns {string} Configuration containing a private origin header.
 */
export function renderProxy(template, { hostname, endpointHostname, originSecret, caFile }) {
  return template.replaceAll('PUBLIC_HOSTNAME', hostname).replaceAll('AWS_ENDPOINT_HOSTNAME', endpointHostname)
    .replaceAll('ORIGIN_SECRET', originSecret).replaceAll('CA_BUNDLE', caFile ?? 'CA_BUNDLE');
}

/**
 * Turn stack output structures into their named deployment values.
 * @param {object} stack - CloudFormation stack description.
 * @returns {object} Output names mapped to output strings.
 */
function outputs(stack) {
  return Object.fromEntries((stack.Outputs ?? []).map((entry) => [entry.OutputKey, entry.OutputValue]));
}

/**
 * Replace a generated file atomically with owner-only permissions on every run.
 * @param {string} file - Output file in the private working directory.
 * @param {string} content - Generated configuration or deployment metadata.
 * @returns {void} Writes without temporarily exposing a formerly public file.
 */
function writePrivate(file, content) {
  const temporary = `${file}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, content, { mode: 0o600, flag: 'wx' });
    renameSync(temporary, file);
  } finally { rmSync(temporary, { force: true }); }
}

/**
 * Apply stack templates, upload immutable code, and verify the AWS HTTP endpoint.
 * Requires Node.js 18+, AWS CLI, and the caller's existing AWS credentials.
 * @param {string[]} [args] - CLI options.
 * @param {object} [services] - Injectable CLI runner and fetch for regression tests.
 * @returns {Promise<object>} Deployment metadata with no secret values.
 */
export async function deployAws(args = process.argv.slice(2), services = {}) {
  if (Number(process.versions.node.split('.')[0]) < 18) throw new Error('Deployment tooling requires Node.js 18 or newer.');
  const options = deploymentOptions(args);
  const cwd = services.cwd ?? process.cwd();
  const output = services.output ?? console.log;
  const execute = services.execute ?? execFileSync;
  const fetchImpl = services.fetch ?? fetch;
  const work = join(cwd, '.deploy');
  mkdirSync(work, { recursive: true, mode: 0o700 });
  const secrets = deploymentSecrets(resolve(cwd, options.secretsFile));
  const temporary = mkdtempSync(join(work, 'parameters-'));

  /**
   * Execute literal AWS CLI arguments, keeping all returned JSON out of logs.
   * @param {string[]} command - AWS service, operation and arguments.
   * @returns {object} Parsed JSON response, or an empty object for a waiter.
   */
  function aws(command) {
    const raw = execute('aws', [...command, '--region', options.region, '--output', 'json', '--no-cli-pager'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 4 * 1024 * 1024,
        env: { ...process.env, AWS_PAGER: '', AWS_CLI_AUTO_PROMPT: 'off' } });
    return raw.trim() ? JSON.parse(raw) : {};
  }

  /**
   * Inspect a stack while distinguishing missing resources from denied access.
   * @param {string} name - Stack name in the selected region.
   * @returns {object|null} Current stack, or null if it has not been created.
   */
  function describe(name) {
    try { return aws(['cloudformation', 'describe-stacks', '--stack-name', name]).Stacks[0]; }
    catch (error) {
      if (/does not exist/i.test(String(error.stderr ?? error.message))) return null;
      throw error;
    }
  }

  /**
   * Create or update one stack, sending parameters through a private JSON file.
   * @param {string} name - Stack name.
   * @param {string|null} template - Relative template file; null retains the old template.
   * @param {object[]} parameters - CloudFormation parameter structures.
   * @returns {object} Completed stack description.
   */
  function apply(name, template, parameters) {
    const before = describe(name);
    if (before && (before.StackStatus.endsWith('_IN_PROGRESS') || before.StackStatus === 'ROLLBACK_COMPLETE')) {
      throw new Error(`Stack ${name} is ${before.StackStatus}. Inspect its CloudFormation events before retrying.`);
    }
    if (!before && !template) throw new Error(`Cannot roll back missing stack ${name}.`);
    const file = join(temporary, `${name}.json`);
    writeFileSync(file, JSON.stringify(parameters), { mode: 0o600 });
    const operation = before ? 'update-stack' : 'create-stack';
    const templateArgs = template ? ['--template-body', `file://${resolve(cwd, template)}`] : ['--use-previous-template'];
    output(`${before ? 'Updating' : 'Creating'} CloudFormation stack ${name} in ${options.region}...`);
    try {
      aws(['cloudformation', operation, '--stack-name', name, ...templateArgs, '--parameters', `file://${file}`, '--capabilities', 'CAPABILITY_IAM']);
    } catch (error) {
      if (before && /No updates are to be performed/i.test(String(error.stderr ?? error.message))) return before;
      throw error;
    }
    aws(['cloudformation', 'wait', before ? 'stack-update-complete' : 'stack-create-complete', '--stack-name', name]);
    return describe(name);
  }

  try {
    const identity = aws(['sts', 'get-caller-identity']);
    output(`Using AWS account ${identity.Account}, region ${options.region}.`);
    const before = describe(options.stack);
    let stack;
    let sha256;
    if (options.rollbackRevision) {
      if (!before) throw new Error('There is no deployed stack to roll back.');
      const hostname = before.Parameters?.find((entry) => entry.ParameterKey === 'PublicHostname')?.ParameterValue;
      if (hostname !== options.hostname) throw new Error('The hostname does not match the deployed stack.');
      const parameters = before.Parameters.map((entry) => entry.ParameterKey === 'RollbackRevisionId'
        ? { ParameterKey: entry.ParameterKey, ParameterValue: options.rollbackRevision }
        : { ParameterKey: entry.ParameterKey, UsePreviousValue: true });
      stack = apply(options.stack, null, parameters);
    } else {
      const artifact = resolve(cwd, options.artifact);
      sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
      const manifestFile = join(dirname(artifact), 'manifest.json');
      if (!existsSync(manifestFile) || JSON.parse(readFileSync(manifestFile, 'utf8')).sha256 !== sha256) {
        throw new Error('The code archive does not match manifest.json. Rebuild it with npm run package:aws.');
      }
      // Ask CloudFormation to validate both templates before creating infrastructure.
      for (const file of ['artifacts.yaml', 'application.yaml']) {
        aws(['cloudformation', 'validate-template', '--template-body', `file://${join(cwd, 'deploy', 'aws', file)}`]);
      }
      const artifacts = apply(`${options.stack}-artifacts`, 'deploy/aws/artifacts.yaml',
        [{ ParameterKey: 'FunctionName', ParameterValue: options.stack }]);
      const bucket = outputs(artifacts).CodeBucket;
      const key = `chores/${sha256}.zip`;
      let version;
      try {
        const object = aws(['s3api', 'head-object', '--bucket', bucket, '--key', key]);
        if (object.Metadata?.sha256 !== sha256) throw new Error('Existing code object has unexpected integrity metadata.');
        version = object.VersionId;
      } catch (error) {
        if (!/\(404\)|Not Found|NoSuchKey/i.test(String(error.stderr ?? error.message))) throw error;
        version = aws(['s3api', 'put-object', '--bucket', bucket, '--key', key, '--body', artifact,
          '--server-side-encryption', 'AES256', '--metadata', `sha256=${sha256}`]).VersionId;
      }
      if (!version || version === 'null') throw new Error('The code bucket did not return a valid object VersionId.');
      const parameters = { FunctionName: options.stack, CodeBucket: bucket, CodeKey: key, CodeVersion: version,
        PublicHostname: options.hostname, HouseholdTimezone: options.timezone,
        OriginSecret: secrets.originSecret, BootstrapToken: secrets.bootstrapToken, RollbackRevisionId: '' };
      stack = apply(options.stack, 'deploy/aws/application.yaml', Object.entries(parameters)
        .map(([ParameterKey, ParameterValue]) => ({ ParameterKey, ParameterValue })));
    }
    const values = outputs(stack);
    const endpoint = new URL(values.EndpointUrl);
    if (endpoint.protocol !== 'https:' || endpoint.hostname !== values.EndpointHostname ||
        !/^[a-z0-9-]+\.[a-z0-9-]+\.lambda-web\.[a-z0-9-]+\.on\.aws$/.test(endpoint.hostname)) {
      throw new Error('CloudFormation did not return a valid regional Lambda Web Function endpoint.');
    }
    const metadata = { account: identity.Account, region: options.region, stackName: options.stack, publicHostname: options.hostname,
      endpointUrl: endpoint.origin, currentRevisionId: values.CurrentRevisionId, servingRevisionId: values.ServingRevisionId,
      previousRevisionId: before ? outputs(before).ServingRevisionId : null, dynamoDBTable: values.DynamoDBTable,
      applicationLogGroup: values.ApplicationLogGroup, regionalLogGroup: values.RegionalLogGroup,
      secretsFile: options.secretsFile,
      timezone: stack.Parameters?.find((entry) => entry.ParameterKey === 'HouseholdTimezone')?.ParameterValue ?? options.timezone,
      ...(sha256 ? { sha256 } : {}) };
    writePrivate(join(work, 'deployment.json'), `${JSON.stringify(metadata, null, 2)}\n`);
    const proxy = renderProxy(readFileSync(join(cwd, 'deploy', 'aws', 'haproxy.cfg.example'), 'utf8'),
      { hostname: options.hostname, endpointHostname: endpoint.hostname, originSecret: secrets.originSecret, caFile: options.caFile });
    writePrivate(join(work, 'haproxy.generated.cfg'), proxy);
    // Endpoints can be Active even when application startup fails; verify real HTTP.
    let healthy = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      try {
        const response = await fetchImpl(`${endpoint.origin}/api/auth/status`, {
          headers: { 'x-app-origin-secret': secrets.originSecret }, redirect: 'error', signal: AbortSignal.timeout(10_000) });
        if (response.ok && typeof (await response.json()).needsSetup === 'boolean') { healthy = true; break; }
      } catch { /* Cold-start and propagation failures receive bounded retries. */ }
      if (attempt < 9) await delay(1_000);
    }
    if (!healthy) throw new Error(`The stack exists but the app did not become healthy. Inspect ${values.ApplicationLogGroup} in CloudWatch.`);
    output(`Application is healthy. Public address: https://${options.hostname}`);
    output('Next: node scripts/bootstrap-deployment.js, then merge .deploy/haproxy.generated.cfg into your existing proxy configuration.');
    output('The generated proxy excerpt contains a secret. Keep it private and replace CA_BUNDLE with the proxy host’s CA file.');
    return metadata;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

// Importing helpers for tests never executes CLI commands or contacts AWS.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await deployAws(); }
  catch (error) {
    let message = String(error.stderr ?? error.message);
    // An AWS error can quote submitted values; remove any configured secret.
    const args = process.argv.slice(2);
    const index = args.indexOf('--secrets-file');
    try {
      const secrets = JSON.parse(readFileSync(index >= 0 ? args[index + 1] : '.deploy/secrets.json', 'utf8'));
      for (const value of [secrets.originSecret, secrets.bootstrapToken]) if (value) message = message.replaceAll(value, '[redacted]');
    } catch { /* Credential-file errors must not hide the original deployment error. */ }
    console.error(message);
    process.exitCode = 1;
  }
}
