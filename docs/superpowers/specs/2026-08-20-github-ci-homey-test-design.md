# GitHub CI and Homey Test Release Design

## Goal

Add continuous validation and automatic publication through GitHub Actions. Every proposed change is validated before merge, and every validated app release merged into `main` is uploaded to Homey as a Draft that can be enabled in the Test channel.

## Continuous integration

Add `.github/workflows/validate.yml`, triggered for pull requests, pushes to `main`, and manual dispatch. The workflow will use Node.js 22 and read-only repository permissions. Concurrent runs for the same branch or pull request will cancel older runs.

The workflow will contain these checks:

- install dependencies reproducibly with `npm ci`;
- run the JavaScript lint script;
- run the complete automated test suite;
- build the app with a pinned Homey CLI version;
- verify that Homey Compose generated files do not introduce an uncommitted `app.json` change;
- validate the application at Homey publish level;
- always report production dependency vulnerabilities and fail on critical-severity findings. The current Homey SDK/CLI dependency tree contains upstream high-severity findings that the application cannot remediate without Athom updates.

Validation and tests remain independent jobs so failures are easy to identify. Pull request workflows receive no Homey account credentials.

## Automatic Homey publication

After CI is green for a push to `main`, a dependent publish job uses Athom's official `athombv/github-action-homey-app-publish` action. Authentication uses an app-owner Personal Access Token stored only as the protected GitHub Actions secret `HOMEY_PAT`. The token is never available to pull request jobs and is never written to the repository or logs.

The action uploads the app to Homey Developer Tools as a Draft. The workflow records the returned management URL in its job summary. Uploading a Draft does not publish it to the Live channel; the release is subsequently enabled for Test in Homey Developer Tools.

Each functional release pull request must update the app version and changelog. The publishing job does not create commits or bump versions after merge, avoiding recursive workflow runs and keeping the released version reviewable in the pull request.

## Delivery flow

1. Create and push the CI change on a branch.
2. Open a pull request and wait for all new checks to pass.
3. Merge the pull request into `main`.
4. The successful `main` workflow automatically uploads the release as a Draft using `HOMEY_PAT`.
5. Enable the Draft in the Homey Test channel through Homey Developer Tools.
6. Verify the Test build is visible and installable through its Test URL.

The automation must not submit for certification or publish to the production/Live channel. A failure at any stage leaves the previous Test build untouched.

## Security and verification

The workflow uses minimal GitHub permissions and exposes `HOMEY_PAT` only to the publish job on trusted pushes to `main`. Third-party actions are pinned to immutable commit SHAs where practical. Before publication, run the same lint, test, build, and publish-level validation locally. Confirm that the repository contains no generated build directory or authentication material, and inspect the final Git diff before pushing.
