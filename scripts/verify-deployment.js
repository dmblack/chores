/**
 * Verify that unsigned AWS access is denied and the allowlisted public proxy can reach the app.
 * Run from an allowed network after public DNS, HAProxy and its IAM signer are configured.
 * The direct probe supplies the private application origin secret without an AWS signature,
 * so the old application-only secret gate cannot satisfy the expected AWS rejection check.
 * This standalone Node.js 18+ command reads the private deployment files and never prints them.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deploymentConfig } from './bootstrap-deployment.js';

/**
 * Verify the unsigned AWS rejection using the valid origin secret, then check the public proxy.
 * No AWS authorization, cookies, redirects or account changes are involved.
 * @param {object} [options] - Dependencies for execution and focused tests.
 * @param {string} [options.cwd] - Deployment bundle root containing metadata and private secrets.
 * @param {Function} [options.fetchImpl] - HTTPS fetch implementation.
 * @param {NodeJS.WriteStream} [options.output] - Safe progress output.
 * @returns {Promise<{directDenied: boolean, needsSetup: boolean, publicUrl: string}>} Verified access outcome.
 */
export async function verifyDeployment({ cwd = process.cwd(), fetchImpl = globalThis.fetch, output = process.stdout } = {}) {
  const { endpointUrl, publicUrl, originSecret } = await deploymentConfig(cwd);
  /** Check one validated endpoint without redirects, retaining a secret only for the AWS probe. */
  const request = async (origin, headers) => {
    try {
      return await fetchImpl(`${origin}/api/auth/status`, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(30_000), ...(headers ? { headers } : {}) });
    } catch {
      throw new Error('Cannot reach a deployment endpoint. Use an allowlisted network and check deployment DNS and HAProxy.');
    }
  };
  const direct = await request(endpointUrl, { 'x-app-origin-secret': originSecret });
  await direct.body?.cancel();
  if (direct.status !== 403) throw new Error(`Unsigned AWS endpoint access was not denied as expected (HTTP ${direct.status}). Check the function IAM authentication policy.`);
  const response = await request(publicUrl);
  if (!response.ok) throw new Error(`Public deployment check failed (HTTP ${response.status}). Check your network allowlist, DNS, HAProxy and IAM signer.`);
  let status;
  try {
    status = await response.json();
  } catch {
    throw new Error('The public deployment returned an invalid setup status. Check HAProxy routing and the application.');
  }
  if (typeof status?.needsSetup !== 'boolean') throw new Error('The public deployment returned an invalid setup status.');
  output.write(`Unsigned AWS endpoint access is denied. Public access through ${publicUrl} works.\n`);
  output.write(status.needsSetup ? 'Create the first parent with scripts/bootstrap-deployment.js.\n' : 'The household is configured. Sign in through the public hostname.\n');
  return { directDenied: true, needsSetup: status.needsSetup, publicUrl };
}

/** Run the command directly without requests or stdin changes when imported by tests. */
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyDeployment();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
