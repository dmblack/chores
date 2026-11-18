Deploy the household app to Oregon (`us-west-2`) with Lambda Web Functions and a DynamoDB table in the same region. DNS points `tasks.fortheherd.net` to your existing EC2 host, which keeps handling TLS termination and HAProxy routing.

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

   The DynamoDB checks use disposable local Docker containers. The package smoke test runs the ZIP in a pinned Node.js 24 Amazon Linux 2023 container and checks startup, account creation, sessions, persisted application data, and PWA files. The test reports its actual CPU architecture; an x64 host tests the runtime on x64, while AWS Web Functions use Arm64. The cloud package contains no native addons: SQLite's unused prebuilt binaries are removed, and the managed-runtime entry point requires DynamoDB. These checks create no AWS resources.

   Packaging produces `.deploy/chores-aws.zip` and `.deploy/chores-cloudshell.zip`. Upload **`chores-cloudshell.zip`** in the next step: it includes the application ZIP, infrastructure templates, release manifest, and deployment/bootstrap scripts. The upload bundle contains no production secrets or household database. Generated files under `.deploy/` are excluded from Git.

2. **Open CloudShell in the intended AWS account and Oregon region.**

   Sign in to the AWS console using your normal IAM or federated account, select **US West (Oregon)**, and open the standard CloudShell terminal. CloudShell already has an authenticated AWS CLI; no local CLI installation or access keys are needed. Use the standard CloudShell environment so your working directory persists between sessions. [AWS CloudShell documentation](https://docs.aws.amazon.com/cloudshell/latest/userguide/welcome.html)

   The signed-in identity needs permission to use CloudShell and create/update the CloudFormation stacks and their resources: S3, IAM roles and policies, `iam:PassRole`, CloudWatch Logs, DynamoDB, and Lambda Web Functions. Console access alone does not guarantee those deployment permissions. The application execution role receives access only to its own table and log groups.

   CloudShell needs Node.js 18 or later and its AWS CLI. Check the current identity and tools before deployment:

   ```bash
   # Verify the shell runtime and which account will receive the resources.
   node --version
   aws --version
   aws sts get-caller-identity
   ```

3. **Upload the bundle and create the deployment.**

   In CloudShell choose **Actions → Upload file**, select the local `.deploy/chores-cloudshell.zip`, then run:

   ```bash
   # Extract the release into a persistent directory in CloudShell's home folder.
   unzip chores-cloudshell.zip -d chores-deploy
   cd chores-deploy

   # Create the artifact stack, upload the code, and deploy the application stack.
   node scripts/deploy-aws.js --hostname tasks.fortheherd.net
   ```

   **This command creates billable AWS resources.** Defaults are region `us-west-2` and stack/function name `chores-tasks`. Use `--region` and `--stack` when you deliberately need different values. The script manages the artifact bucket stack first, uploads the code under a SHA-based `chores/` key, records its S3 object version, and creates or updates the application stack. CloudFormation is used directly; the separate `aws lambda-web` CLI commands are not required.

   On the first run, the script generates separate origin and first-account secrets in `.deploy/secrets.json`, readable only by its owner. Later runs reuse them. Secret values go through private parameter files and are not printed. An existing secret file can be supplied with `--secrets-file`; `--artifact` selects a different application ZIP.

   The resulting files are:

   | File in CloudShell | Purpose |
   | --- | --- |
   | `.deploy/deployment.json` | Endpoint, public hostname, revision ID, table, and deployment details; no secrets. |
   | `.deploy/secrets.json` | Stable origin and bootstrap secrets; keep private and preserve for updates. |
   | `.deploy/haproxy.generated.cfg` | Generated proxy excerpt containing the origin secret; transfer privately to the proxy host. |

   The S3 bucket is private and versioned. Lambda is allowed to read only this function's deployment objects. Every revision pins an exact object version. Keep object versions and bucket permissions while revisions reference them; removing either can permanently fail a revision. [AWS deployment package requirements](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-code-s3.html)

4. **Create the first parent account.**

   Before exposing the public hostname, run this from the same CloudShell directory:

   ```bash
   # Provision the first parent through the authenticated AWS origin endpoint.
   node scripts/bootstrap-deployment.js
   ```

   Enter the parent's username, display name, date of birth, and password. Password entry and its confirmation are hidden. The helper reads the private deployment files, sends the required origin and bootstrap headers over HTTPS, and does not save the returned sign-in session. Sign in normally after the public route is connected. Account creation is closed once the household has its first parent.

5. **Connect the existing HAProxy host.**

   Set the DNS **A record for `tasks.fortheherd.net` to your existing HAProxy EC2 public IP**. Obtain or extend its TLS certificate for that hostname using your existing certificate workflow. The application stack creates neither the DNS record nor that certificate.

   Transfer `.deploy/haproxy.generated.cfg` privately to the EC2 host. CloudShell's **Actions → Download file** accepts the file's full path if downloading through your workstation. Treat it as a credential file because it contains the origin secret.

   Merge its resolver and backend sections into the current HAProxy configuration. Uncomment and insert the two host ACL/routing lines **inside the existing TLS-terminating HTTP frontend**. Preserve its other services and existing TLS settings.

   Replace `CA_BUNDLE` with the correct trusted CA bundle path on the EC2 host. Alternatively, pass `--ca-file /the/host/ca-bundle-path` to the deployment script when generating the excerpt. The upstream endpoint hostname is used for `Host`, SNI, and certificate validation; forwarding headers and the origin header are overwritten by HAProxy. No periodic HTTP health check is configured, so health checks do not keep waking the app.

   Keep the frontend client timeout at least 60 seconds for the stream heartbeat. Validate the **complete merged configuration** with `haproxy -c -f /path/to/your/actual/config` and reload using the host's usual service procedure only after validation passes. The supplied file is an excerpt, not a replacement configuration.

6. **Check the public deployment.**

   Open `https://tasks.fortheherd.net`, sign in, and create the other household accounts. Confirm that two devices can see task changes and approvals, that points are awarded once, and that `/watch` loads. On an iPad, test Add to Home Screen, reopen the installed app, and check one offline action after reconnecting.

   Direct requests to the AWS endpoint without the origin header should return `403`. If the endpoint is marked active but requests fail, inspect the regional log group listed in `deployment.json`; AWS endpoint readiness does not prove application startup succeeded. Both regional and centralized logs have 14-day retention. [AWS startup and deployment troubleshooting](https://docs.aws.amazon.com/lambda/latest/dg/web-functions-troubleshooting.html)

For an **update**, repeat the local checks and packaging, upload the new CloudShell bundle, and extract it into the **same directory**:

```bash
# Run from the CloudShell home directory after uploading the new bundle.
unzip -o chores-cloudshell.zip -d chores-deploy
cd chores-deploy

# Reuse the existing secrets and update the version-pinned application revision.
node scripts/deploy-aws.js --hostname tasks.fortheherd.net
```

Preserve `.deploy/secrets.json` and record the current revision ID before updating. Starting in a fresh directory would generate different secrets and require a matching HAProxy update. Keep a private backup of the secrets file using your usual credential backup process.

For a **code rollback**, use a previous retained revision ID of this same Web Function:

```bash
# Route traffic to a previous revision without uploading or rebuilding code.
node scripts/deploy-aws.js --hostname tasks.fortheherd.net --rollback-revision PREVIOUS_REVISION_ID
```

The rollback changes endpoint traffic using the existing stack parameters and template. It does not reverse database events or restore an earlier household state. Retained revisions contain their original secrets and configuration, so keep the origin secret stable across releases. A subsequent normal deployment command resumes deployment of the packaged revision.

The initial endpoint has a **ceiling of two execution environments**, not two permanently running instances. It can scale to zero. The 100 requests/second endpoint throttle is AWS's smallest nonzero setting; neither setting is a spending cap. Live foreground connections can keep an environment active, and memory, CPU, requests, DynamoDB, logs, and transfer contribute to the bill. Check actual usage after the first few days. [AWS scaling limits](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionendpoint-scalingconfig.html), [endpoint throttling](https://docs.aws.amazon.com/AWSCloudFormation/latest/TemplateReference/aws-properties-lambda-webfunctionendpoint-throttleconfig.html)

The database uses on-demand capacity, AWS owned key encryption, seven days of point-in-time recovery, and deletion protection. The database, code bucket, and prior revisions are retained for recovery and rollback. Removing the application stack therefore does not clean up every resource or end every storage charge. Review and remove retained resources deliberately when retiring the deployment; disable table deletion protection only when you intend to delete its data.
