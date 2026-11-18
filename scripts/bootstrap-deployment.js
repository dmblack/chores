/**
 * Create the first parent through a protected deployment without storing its password or session.
 * Run this standalone Node.js 18+ command from an allowlisted network after public DNS and
 * HAProxy are connected. It reaches the application through the public proxy hostname.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

/**
 * Validate the protected AWS endpoint and the public proxy origin independently of secrets.
 * @param {object} deployment - Persisted non-secret deployment metadata.
 * @returns {{endpointUrl: string, publicUrl: string}} Validated HTTPS origins.
 */
export function deploymentLocations(deployment) {
  let endpoint;
  let publicUrl;
  try {
    endpoint = new URL(deployment.endpointUrl);
    publicUrl = new URL(deployment.publicUrl ?? `https://${deployment.publicHostname}`);
  } catch {
    throw new Error('Deployment configuration contains an invalid endpoint or public hostname.');
  }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.port ||
      endpoint.pathname !== '/' || endpoint.search || endpoint.hash ||
      !/^[a-z0-9-]+\.[a-z0-9-]+\.lambda-web\.[a-z0-9-]+\.on\.aws$/i.test(endpoint.hostname)) {
    throw new Error('The deployment endpoint must be an HTTPS AWS Lambda Web Function URL.');
  }
  if (publicUrl.protocol !== 'https:' || publicUrl.username || publicUrl.password || publicUrl.port ||
      publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash ||
      !/^[a-z0-9.-]+$/i.test(publicUrl.hostname) || !publicUrl.hostname.includes('.') || publicUrl.hostname === endpoint.hostname) {
    throw new Error('The deployment public hostname must be a valid HTTPS origin.');
  }
  return { endpointUrl: endpoint.origin, publicUrl: publicUrl.origin };
}

/**
 * Read deployment and secret files without exposing their contents in errors.
 * @param {string} cwd - Deployment bundle root containing the .deploy directory.
 * @returns {Promise<object>} Validated origins and authentication headers.
 */
export async function deploymentConfig(cwd) {
  let deployment;
  let secrets;
  try {
    deployment = JSON.parse(await readFile(resolve(cwd, '.deploy/deployment.json'), 'utf8'));
    secrets = JSON.parse(await readFile(resolve(cwd, deployment.secretsFile ?? '.deploy/secrets.json'), 'utf8'));
  } catch {
    throw new Error('Cannot read deployment configuration. Run the deployment command first from this directory.');
  }
  const locations = deploymentLocations(deployment);
  if (!/^[a-f0-9]{64}$/i.test(secrets?.originSecret ?? '') || !/^[a-f0-9]{64}$/i.test(secrets?.bootstrapToken ?? '')) {
    throw new Error('Deployment authentication secrets are missing or invalid. Run the deployment command first.');
  }
  return { ...locations,
    originSecret: secrets.originSecret, bootstrapToken: secrets.bootstrapToken };
}

/**
 * Read one password directly from a terminal while echo is disabled.
 * @param {NodeJS.ReadStream} input - Interactive terminal input.
 * @param {NodeJS.WriteStream} output - Terminal prompt output.
 * @param {string} prompt - Prompt with no secret content.
 * @returns {Promise<string>} Password, kept only in process memory.
 */
function hiddenAnswer(input, output, prompt) {
  input.setEncoding('utf8');
  input.resume();
  input.setRawMode(true);
  output.write(prompt);
  return new Promise((resolveAnswer, rejectAnswer) => {
    let value = '';
    /** Restore the terminal and release listeners before completing the prompt. */
    const finish = () => {
      input.off('data', onData);
      input.off('end', onEnd);
      input.off('error', onEnd);
      input.setRawMode(false);
      input.pause();
      output.write('\n');
    };
    /** Reject incomplete input without including the password in diagnostics. */
    const onEnd = () => {
      finish();
      rejectAnswer(new Error('Input ended before setup was complete. Nothing was submitted.'));
    };
    /** Interpret terminal editing keys without printing any entered characters. */
    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === '\r' || character === '\n') {
          finish();
          resolveAnswer(value);
          return;
        }
        if (character === '\u0003' || character === '\u0004') {
          finish();
          rejectAnswer(new Error('Setup cancelled. Nothing was submitted.'));
          return;
        }
        if (character === '\u007f' || character === '\b') value = Array.from(value).slice(0, -1).join('');
        else if (character >= ' ') value += character;
      }
    };
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('error', onEnd);
  });
}

/**
 * Own input from startup so piped lines remain buffered while deployment status is checked.
 * @param {object} [options] - Optional streams for automation and focused tests.
 * @param {NodeJS.ReadStream} [options.input] - Terminal or piped input.
 * @param {NodeJS.WriteStream} [options.output] - Prompt output; piped answers are never echoed.
 * @returns {{ask: Function, close: Function}} Visible/hidden prompts and final cleanup.
 */
export function createPrompter({ input = process.stdin, output = process.stdout } = {}) {
  const piped = !input.isTTY;
  const readline = createInterface({ input, ...(piped ? {} : { output, terminal: true }) });
  const lines = piped ? readline[Symbol.asyncIterator]() : null;
  let readlineClosed = false;
  /** Close readline once before switching a terminal to raw password input. */
  const closeReadline = () => {
    if (!readlineClosed) readline.close();
    readlineClosed = true;
  };
  return {
    /** Read a prompt without echoing any piped input or any terminal password. */
    async ask(prompt, { hidden = false } = {}) {
      if (piped) {
        const { value, done } = await lines.next();
        if (done) throw new Error('Input ended before setup was complete. Nothing was submitted.');
        return value;
      }
      if (hidden) {
        closeReadline();
        return hiddenAnswer(input, output, prompt);
      }
      if (readlineClosed) throw new Error('Cannot ask for visible input after a password prompt.');
      return new Promise((resolveAnswer, rejectAnswer) => {
        /** Detach cancellation handlers once this question has an answer. */
        const cleanup = () => {
          readline.off('SIGINT', onCancelled);
          readline.off('close', onCancelled);
        };
        /** Reject cancellation instead of leaving the command waiting forever. */
        const onCancelled = () => {
          cleanup();
          rejectAnswer(new Error('Setup cancelled. Nothing was submitted.'));
        };
        readline.once('SIGINT', onCancelled);
        readline.once('close', onCancelled);
        readline.question(prompt, (answer) => {
          cleanup();
          resolveAnswer(answer);
        });
      });
    },
    /** Release input even when setup is already complete or validation fails. */
    close() {
      closeReadline();
      input.pause();
    },
  };
}

/**
 * Validate the prompted profile locally before making its one setup request.
 * @param {object} profile - Username, nickname, birth date and password.
 * @returns {void} Throws a safe validation message on invalid input.
 */
function validateProfile({ username, nickname, birthDate, password }) {
  if (!/^[a-zA-Z0-9._-]{2,32}$/.test(username)) throw new Error('Username must contain 2–32 letters, numbers, dots, dashes or underscores.');
  if (!nickname || nickname.length > 30) throw new Error('Nickname must contain 1–30 characters.');
  const parsed = new Date(`${birthDate}T00:00:00Z`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== birthDate) {
    throw new Error('Birth date must be a valid date in YYYY-MM-DD format.');
  }
  if (password.length < 6 || password.length > 200) throw new Error('Password must contain 6–200 characters.');
}

/**
 * Check public setup status, collect the first parent's details and submit them through HAProxy.
 * @param {object} [options] - Dependency injection for local tests; production uses the global fetch.
 * @param {string} [options.cwd] - Deployment bundle root.
 * @param {Function} [options.fetchImpl] - HTTPS fetch implementation.
 * @param {object} [options.prompter] - Prompt owner with ask() and close().
 * @param {NodeJS.WriteStream} [options.output] - Safe progress output.
 * @returns {Promise<{created: boolean, publicUrl: string}>} Setup outcome without credentials or session data.
 */
export async function bootstrapDeployment({ cwd = process.cwd(), fetchImpl = globalThis.fetch,
  prompter = createPrompter(), output = process.stdout } = {}) {
  try {
    const config = await deploymentConfig(cwd);
    /** Fetch without redirects so deployment secrets are never forwarded to another endpoint. */
    const request = async (path, options = {}) => {
      try {
        return await fetchImpl(`${config.publicUrl}${path}`, { ...options, redirect: 'error',
          signal: AbortSignal.timeout(30_000), headers: { 'x-app-origin-secret': config.originSecret, ...options.headers } });
      } catch {
        throw new Error('Cannot reach the public deployment. Use an allowlisted network and check DNS and HAProxy, then try again.');
      }
    };
    const status = await request('/api/auth/status', { method: 'GET' });
    if (!status.ok) throw new Error(`Deployment status check failed (HTTP ${status.status}). Check your network allowlist and HAProxy access, then try again.`);
    let current;
    try {
      current = await status.json();
    } catch {
      throw new Error('The deployment returned an invalid setup status. Check the deployment and try again.');
    }
    if (typeof current?.needsSetup !== 'boolean') throw new Error('The deployment returned an invalid setup status.');
    if (!current.needsSetup) {
      output.write(`The first parent is already configured. Sign in at ${config.publicUrl}\n`);
      return { created: false, publicUrl: config.publicUrl };
    }
    const username = (await prompter.ask('Username: ')).trim();
    const nickname = (await prompter.ask('Nickname: ')).trim();
    const birthDate = (await prompter.ask('Birth date (YYYY-MM-DD): ')).trim();
    const password = await prompter.ask('Password (6–200 characters): ', { hidden: true });
    const repeated = await prompter.ask('Same password again: ', { hidden: true });
    if (password !== repeated) throw new Error('The passwords do not match. Nothing was submitted.');
    const profile = { username, nickname, birthDate, password };
    validateProfile(profile);
    const response = await request('/api/auth/setup', { method: 'POST', headers: {
      'Content-Type': 'application/json', 'x-bootstrap-token': config.bootstrapToken }, body: JSON.stringify(profile) });
    await response.body?.cancel();
    if (response.status === 409) {
      output.write(`The first parent is already configured. Sign in at ${config.publicUrl}\n`);
      return { created: false, publicUrl: config.publicUrl };
    }
    if (!response.ok) throw new Error(`Initial account creation failed (HTTP ${response.status}). Check the deployment and profile requirements, then run this command again.`);
    output.write(`First parent created. Sign in at ${config.publicUrl}\n`);
    return { created: true, publicUrl: config.publicUrl };
  } finally {
    prompter.close();
  }
}

/** Run as a CLI without executing or opening stdin when imported by tests. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await bootstrapDeployment();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
