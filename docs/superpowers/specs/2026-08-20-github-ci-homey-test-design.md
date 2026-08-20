# GitHub CI and Homey Test Release Design

## Goal

Add the same release model used by the Vasco app: GitHub validates every proposed change, while publishing to the Homey Test channel is performed locally with an already authenticated Homey CLI session.

## Continuous integration

Add `.github/workflows/validate.yml`, triggered for pull requests, pushes to `main`, and manual dispatch. The workflow will use Node.js 22 and read-only repository permissions. Concurrent runs for the same branch or pull request will cancel older runs.

The workflow will contain these checks:

- install dependencies reproducibly with `npm ci`;
- run the JavaScript lint script;
- run the complete automated test suite;
- build the app with a pinned Homey CLI version;
- verify that Homey Compose generated files do not introduce an uncommitted `app.json` change;
- validate the application at Homey publish level;
- fail on high-severity production dependency vulnerabilities.

Validation and tests remain independent jobs so failures are easy to identify. GitHub Actions receives no Homey account credentials.

## Homey Test publication

After CI is green on `main`, run `homey app publish` from the trusted local development machine. Use the existing Homey CLI login and select the Test channel. No OAuth session, refresh token, password, or CLI configuration will be copied into GitHub Secrets.

Automatic publication from GitHub is outside this scope. It may be added later only if Homey provides a supported non-interactive credential suitable for CI, or through a separately secured self-hosted runner.

## Delivery flow

1. Create and push the CI change on a branch.
2. Open a pull request and wait for all new checks to pass.
3. Merge the pull request into `main`.
4. Confirm the `main` workflow is green.
5. Publish the current `main` commit locally to Homey Test.
6. Verify the Test build is visible and installable through Homey.

Publishing must stop before any production/live-channel confirmation. A failure at any stage leaves the previous Test build untouched.

## Security and verification

The workflow uses minimal GitHub permissions and does not print or store Homey credentials. Before publication, run the same lint, test, build, and publish-level validation locally. Confirm that the repository contains no generated build directory or authentication material, and inspect the final Git diff before pushing.

