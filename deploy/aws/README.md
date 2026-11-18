Deploy the household app to Oregon (`us-west-2`) with Lambda Web Functions and a DynamoDB table in the same region. DNS points `tasks.fortheherd.net` to your existing EC2 host, which keeps handling TLS termination, its existing source-IP allowlist, and HAProxy routing. HAProxy forwards through a loopback signing helper to an IAM-protected AWS endpoint.

The endpoint accepts requests signed with temporary credentials issued to the approved EC2 instance and its approved IAM role. Other roles, other instances, and unsigned callers are explicitly denied before application code runs. The AWS hostname remains publicly reachable; IAM controls invocation rather than providing a private network address. The helper listens only on `127.0.0.1:8787`, forwards to one fixed HTTPS AWS origin, and obtains credentials only through IMDSv2. It stores no AWS keys and supports the app's live event stream. [AWS endpoint authorization](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-endpoint-access-control.html), [EC2 credential condition key](https://docs.aws.amazon.com/IAM/latest/UserGuide/reference_policies_condition-keys.html#condition-keys-ec2sourceinstancearn)

The helper permits at most 32 active requests, including live streams, and limits each request body to the application's existing 1 MiB limit. Excess concurrent requests receive a retryable `503` before body buffering or AWS access. This bounds its request workload on the small proxy host. The service records memory and CPU usage for inspection after installation.

The household calendar remains in `Australia/Melbourne`, including daylight saving, even though the server runs overseas. The deployment sets the server's `TZ` explicitly so task days do not roll over at UTC midnight. Use `--timezone` with another IANA timezone only when changing the household's calendar is intended.

This creates a **new, empty household** in DynamoDB. Existing SQLite data stays in its current database; this workflow does not copy it. The application, PWA files, API, and `/watch` page share one deployment. CloudFormation manages the AWS resources through the two templates in this directory.

1. **Build and check the release locally.**

   Use Node.js 24.7 or later, npm, Docker, `zip`, and `unzip`. Start from the reviewed project checkout and commit the source changes before publishing the release. Run these commands from the repository root:

   ```bash
   # Install the locked dependencies and check both storage backends.
   npm ci
   npm test
   npm run test:dynamodb

   # Build the deployment bundles and exercise the actual application ZIP.
   npm run package:aws
   npm run test:aws-package
   ```

   Packaging also tests and builds static Linux signing helpers for x86_64 and arm64 in a pinned Go Docker image, with locked SDK dependencies and checksums. The EC2 host needs neither Node.js nor a compiler. The Go tests cover signing, fixed-origin restrictions, body limits, credential caching, and streamed responses. Run `npm run build:signer` to test/build the helper separately.

   The DynamoDB checks use disposable local Docker containers. The package smoke test runs the ZIP in a pinned Node.js 24 Amazon Linux 2023 container and checks startup, account creation, sessions, persisted application data, and PWA files. The test reports its actual CPU architecture; an x64 host tests the runtime on x64, while AWS Web Functions use Arm64. The cloud package contains no native addons: SQLite's unused prebuilt binaries are removed, and the managed-runtime entry point requires DynamoDB. These checks create no AWS resources.

   Packaging produces `.deploy/chores-aws.zip` and `.deploy/chores-cloudshell.zip`. Upload **`chores-cloudshell.zip`** in the next step: it includes the application ZIP, infrastructure templates, release manifest, deployment/bootstrap/verification scripts, and both helper binaries. The upload bundle contains no production secrets or household database. Generated files under `.deploy/` are excluded from Git.

2. **Open CloudShell in the intended AWS account and Oregon region.**

   Sign in to the AWS console using your normal IAM or federated account, select **US West (Oregon)**, and open the standard CloudShell terminal. CloudShell already has an authenticated AWS CLI; no local CLI installation or access keys are needed. Use the standard CloudShell environment so your working directory persists between sessions. [AWS CloudShell documentation](https://docs.aws.amazon.com/cloudshell/latest/userguide/welcome.html)

   The signed-in identity needs permission to use CloudShell and create/update the CloudFormation stacks and their resources: S3, IAM roles and policies, `iam:PassRole`, CloudWatch Logs, DynamoDB, Lambda Web Functions and resource policies, plus read access to the existing EC2 instance and its IAM instance profile. Console access alone does not guarantee those deployment permissions. The application execution role receives access only to its own table and log groups.

   CloudShell needs Node.js 18 or later and its AWS CLI. Check the current identity and tools before deployment:

   ```bash
   # Verify the shell runtime and which account will receive the resources.
   node --version
   aws --version
   aws sts get-caller-identity
   ```

3. **Identify the existing proxy and deploy the AWS application.**

   In the EC2 console, select the HAProxy instance and record its instance ID, region, account ID, and attached IAM role ARN. The proxy can be in a different region from the Oregon application. Use the **role ARN**, not its instance-profile ARN.

   If no IAM role is attached, create an IAM role trusted by EC2 and attach it through **Actions → Security → Modify IAM role**. The application resource policy grants invocation permission, so this role needs no broad Lambda or DynamoDB permissions. If an instance role already exists, keep it and use its ARN. The deployment script checks the instance profile without creating, replacing, or modifying it. [EC2 instance roles](https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/iam-roles-for-amazon-ec2.html)

   The instance metadata endpoint must be enabled and support IMDSv2. Require IMDSv2 (`HttpTokens=required`) in the instance metadata settings; the helper never falls back to IMDSv1. It runs directly on the host and needs access to `169.254.169.254:80` and outbound HTTPS to the fixed Lambda endpoint. Its TLS client uses the operating system's trusted CA certificates.

   In CloudShell choose **Actions → Upload file**, select the local `.deploy/chores-cloudshell.zip`, then run:

   ```bash
   # Extract the release into a persistent directory in CloudShell's home folder.
   unzip chores-cloudshell.zip -d chores-deploy
   cd chores-deploy

   # Replace the proxy identity placeholders with this existing instance and role.
   # The proxy ARN uses its own region; the app still deploys to us-west-2.
   node scripts/deploy-aws.js --hostname tasks.fortheherd.net \
     --proxy-instance-arn arn:aws:ec2:PROXY_REGION:ACCOUNT_ID:instance/INSTANCE_ID \
     --proxy-role-arn arn:aws:iam::ACCOUNT_ID:role/ROLE_NAME
   ```

   **This command creates billable AWS resources.** Defaults are region `us-west-2` and stack/function name `chores-tasks`. Use `--region` and `--stack` when you deliberately need different values. The script manages the artifact bucket stack first, uploads the code under a SHA-based `chores/` key, records its S3 object version, and creates or updates the application stack. CloudFormation is used directly; the separate `aws lambda-web` CLI commands are not required.

   On the first run, the script generates separate origin and first-account secrets in `.deploy/secrets.json`, readable only by its owner. Later runs reuse them. Secret values go through private parameter files and are not printed. An existing secret file can be supplied with `--secrets-file`; `--artifact` selects a different application ZIP.

   Both the proxy and role must belong to the account used for deployment. After the stack completes, the script verifies that AWS rejects an unsigned request even when it contains the valid application origin secret. This proves the old public access path is closed; it does not claim the application has started. Application readiness is checked through HAProxy after connecting the route.

   The resulting files are:

   | File in CloudShell | Purpose |
   | --- | --- |
   | `.deploy/deployment.json` | Endpoint, public hostname, revision ID, table, and deployment details; no secrets. |
   | `.deploy/secrets.json` | Stable origin and bootstrap secrets; keep private and preserve for updates. |
   | `.deploy/haproxy.generated.cfg` | Generated proxy excerpt containing the origin secret; transfer privately to the proxy host. |
   | `.deploy/chores-signer.env` | Fixed AWS origin and signing region; contains no AWS credentials. |
   | `.deploy/signer/` | Static helper binaries for both Linux architectures, checksums, and build metadata. |

   The S3 bucket is private and versioned. Lambda is allowed to read only this function's deployment objects. Every revision pins an exact object version. Keep object versions and bucket permissions while revisions reference them; removing either can permanently fail a revision. [AWS deployment package requirements](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)

4. **Install the signing helper and connect HAProxy.**

   Set the DNS **A record for `tasks.fortheherd.net` to your existing HAProxy EC2 public IP**. Obtain or extend its TLS certificate through your existing certificate workflow. The application stack creates neither the DNS record nor that certificate.

   Transfer `.deploy/haproxy.generated.cfg`, `.deploy/chores-signer.env`, `.deploy/signer/`, and `deploy/aws/chores-signer.service` privately from the deployment directory to the EC2 host. The local release bundle already contains the binaries and service file; CloudShell generates the endpoint-specific environment and HAProxy files. CloudShell's **Actions → Download file** accepts full paths. Keep the generated HAProxy file private because it contains the origin secret. The first-parent secret stays off the proxy host.

   On a Linux host with systemd, run the following from the transferred deployment directory. The service uses the host's CA certificate store, so install/update the operating system's `ca-certificates` package through your existing package-management process if it is missing.

   ```bash
   # Verify the transferred binaries before selecting the host architecture.
   (cd .deploy/signer && sha256sum -c SHA256SUMS)
   case "$(uname -m)" in
     x86_64) signer_arch=amd64 ;;
     aarch64|arm64) signer_arch=arm64 ;;
     *) printf 'Unsupported signer architecture\n' >&2; exit 1 ;;
   esac

   # Install the static helper, its fixed origin, and the hardened service unit.
   sudo install -o root -g root -m 0755 ".deploy/signer/linux-${signer_arch}/chores-signer" /usr/local/bin/chores-signer
   sudo install -o root -g root -m 0600 .deploy/chores-signer.env /etc/chores-signer.env
   sudo install -o root -g root -m 0644 deploy/aws/chores-signer.service /etc/systemd/system/chores-signer.service
   sudo systemctl daemon-reload
   sudo systemctl enable --now chores-signer

   # Inspect service health and measured resource usage without printing credentials.
   sudo systemctl status chores-signer --no-pager
   sudo systemctl show chores-signer -p MemoryCurrent -p CPUUsageNSec
   ```

   Merge `.deploy/haproxy.generated.cfg` into the existing configuration. Uncomment and insert its host ACL/routing lines **inside the existing TLS-terminating HTTP frontend**. Preserve the existing source-IP restrictions, certificates, and other services. The backend connects only to `127.0.0.1:8787`; the helper replaces AWS signing headers, fixes the upstream host, and verifies upstream TLS. No periodic HTTP health check is configured, so checks do not keep waking the app.

   Keep the frontend client timeout at least 60 seconds for the 25-second stream heartbeat. Validate the **complete merged configuration** with `haproxy -c -f /path/to/your/actual/config` and reload through the host's usual service procedure after validation passes. The supplied file is an excerpt, not a replacement configuration. Other init systems need an equivalent unprivileged service; confirm the host's operating system before using these systemd commands.

5. **Verify the route and create the first parent from an allowed network.**

   On your workstation, use Node.js 18 or later and the same extracted release or repository. Download `.deploy/deployment.json` and `.deploy/secrets.json` from CloudShell into that directory's `.deploy/` folder, preserving any custom `--secrets-file` path. Keep the secret file private. Local AWS CLI credentials are not needed for these steps.

   Run from a network already allowed through HAProxy. CloudShell is generally outside that allowlist, and direct AWS setup requests are now denied by design.

   ```bash
   # Keep the downloaded setup secrets readable only by your workstation user.
   chmod 600 .deploy/secrets.json

   # Check public app readiness and that the AWS endpoint rejects unsigned access.
   node scripts/verify-deployment.js

   # Create the first parent through the allowlisted public HAProxy hostname.
   node scripts/bootstrap-deployment.js
   ```

   Enter the parent's username, display name, date of birth, and password. Password entry and confirmation are hidden. The helper sends the private bootstrap header over HTTPS through the public hostname, rejects redirects, and does not save the returned session. Account creation is closed once the first parent exists. Sign in normally afterward.

6. **Check the public deployment.**

   Open `https://tasks.fortheherd.net`, sign in, and create the other household accounts. Confirm that two devices can see task changes and approvals, that points are awarded once, and that `/watch` loads. On an iPad, test Add to Home Screen, reopen the installed app, and check one offline action after reconnecting.

   Direct unsigned requests to the AWS endpoint must return `403`, including requests with the correct origin header. App access requires the approved EC2-issued credentials, the HAProxy origin header, and normal household authentication. If the endpoint is marked active but requests fail, inspect the regional log group listed in `deployment.json`; AWS endpoint readiness does not prove application startup succeeded. Both regional and centralized logs have 14-day retention. [AWS startup and deployment troubleshooting](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-troubleshooting.html)

For an **update**, repeat the local checks and packaging, upload the new CloudShell bundle, and extract it into the **same directory**:

```bash
# Run from the CloudShell home directory after uploading the new bundle.
unzip -o chores-cloudshell.zip -d chores-deploy
cd chores-deploy

# Reuse the existing secrets and update the version-pinned application revision.
node scripts/deploy-aws.js --hostname tasks.fortheherd.net
```

Normal updates reuse the deployed proxy instance and role; omit those arguments unless deliberately changing the proxy identity. An explicit change is checked against the instance's actual profile before provisioning. Code rollbacks preserve the approved proxy identity and cannot change it. Reinstall the helper binary and restart its service when a release changes the helper; reinstall the generated environment file when the AWS endpoint or region changes.

Preserve `.deploy/secrets.json` and record the current revision ID before updating. Starting in a fresh directory would generate different secrets and require a matching HAProxy update. Keep a private backup of the secrets file using your usual credential backup process.

For a **code rollback**, use a previous retained revision ID of this same Web Function:

```bash
# Route traffic to a previous revision without uploading or rebuilding code.
node scripts/deploy-aws.js --hostname tasks.fortheherd.net --rollback-revision PREVIOUS_REVISION_ID
```

The rollback changes endpoint traffic using the existing stack parameters and template. It does not reverse database events or restore an earlier household state. Retained revisions contain their original secrets and configuration, so keep the origin secret stable across releases. A subsequent normal deployment command resumes deployment of the packaged revision.

The initial endpoint has a **ceiling of two execution environments**, not two permanently running instances. It can scale to zero. The 100 requests/second endpoint throttle is AWS's smallest nonzero setting; neither setting is a spending cap. Live foreground connections can keep an environment active, and memory, CPU, requests, DynamoDB, logs, and transfer contribute to the bill. Check actual usage after the first few days. [AWS scaling limits](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionendpoint-scalingconfig.html), [endpoint throttling](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionendpoint-throttleconfig.html)

The database uses on-demand capacity, AWS owned key encryption, seven days of point-in-time recovery, and deletion protection. The database, code bucket, and prior revisions are retained for recovery and rollback. Removing the application stack therefore does not clean up every resource or end every storage charge. Review and remove retained resources deliberately when retiring the deployment; disable table deletion protection only when you intend to delete its data.
