# GitHub CI and Homey Test Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Validate every change on GitHub and automatically upload each validated release merged into `main` to Homey Developer Tools as a Draft.

**Architecture:** One GitHub Actions workflow runs independent lint/test, Homey publish validation, and dependency-audit jobs. A publish job is gated on all checks, runs only for trusted pushes to `main`, and invokes Athom's official publish action with the repository secret `HOMEY_PAT`.

**Tech Stack:** GitHub Actions, Node.js 22, npm, Homey CLI 4.4.1, Homey Apps SDK v3, Athom Homey App Publish Action.

**Spec:** `docs/superpowers/specs/2026-08-20-github-ci-homey-test-design.md`

## Global Constraints

- Use Node.js 22.
- Run `npm ci`, `npm run lint`, `npm test`, Homey publish-level validation, and `npm audit --omit=dev --audit-level=critical` so all findings are reported while critical findings block delivery.
- Pull request jobs must not receive Homey credentials.
- Expose `HOMEY_PAT` only to the publish job on trusted pushes to `main`.
- Upload only a Draft; do not submit for certification or publish to Live.
- Pin reusable actions to immutable commit SHAs.
- The workflow must not create version commits or recursively trigger itself.

---

### Task 1: Continuous integration workflow

**Files:**
- Create: `.github/workflows/validate.yml`

**Interfaces:**
- Consumes: existing npm scripts `lint` and `test`, Homey Compose source, and `package-lock.json`.
- Produces: GitHub checks named `Test`, `Homey validate`, and `Dependency audit` for pull requests and `main`.

- [ ] **Step 1: Add a workflow contract test that initially fails because the workflow is absent**

Run:

```bash
test -f .github/workflows/validate.yml
```

Expected: non-zero exit because the file does not exist.

- [ ] **Step 2: Create the validation workflow**

Create `.github/workflows/validate.yml` with this structure:

```yaml
name: Validate and publish Homey app

on:
  push:
    branches: [main]
  pull_request:
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: homey-${{ github.workflow }}-${{ github.event.pull_request.number || github.ref }}
  cancel-in-progress: true

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run lint
      - run: npm test

  homey-validate:
    name: Homey validate
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm install --global homey@4.4.1
      - run: homey app build
      - run: git diff --exit-code -- app.json
      - run: homey app validate --level publish

  dependency-audit:
    name: Dependency audit
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm audit --omit=dev --audit-level=critical
```

- [ ] **Step 3: Verify local equivalents of all CI checks**

Run:

```bash
npm ci
npm run lint
npm test
homey app build
git diff --exit-code -- app.json
homey app validate --level publish
npm audit --omit=dev --audit-level=critical
```

Expected: every command exits zero; tests report 77 passing tests; `app.json` remains unchanged.

- [ ] **Step 4: Commit the CI workflow**

```bash
git add .github/workflows/validate.yml
git commit -m "ci: validate Homey app on GitHub"
```

### Task 2: Trusted automatic Draft publication

**Files:**
- Modify: `.github/workflows/validate.yml`
- Create: `.homeychangelog.json`

**Interfaces:**
- Consumes: successful `test`, `homey-validate`, and `dependency-audit` jobs; GitHub secret `HOMEY_PAT`; app version `0.0.1`.
- Produces: a Homey Developer Tools Draft and its management URL in `$GITHUB_STEP_SUMMARY`.

- [ ] **Step 1: Add a failing static assertion for the publish gate**

Run:

```bash
rg -n "github.event_name == 'push'.*github.ref == 'refs/heads/main'" .github/workflows/validate.yml
```

Expected: no match and a non-zero exit before the publish job is added.

- [ ] **Step 2: Add initial localized release notes**

Create `.homeychangelog.json`:

```json
{
  "0.0.1": {
    "en": "Initial Test release with GROHE Blue Home monitoring and automatic flushing controls.",
    "pl": "Pierwsza wersja testowa z monitorowaniem GROHE Blue Home i sterowaniem automatycznym płukaniem."
  }
}
```

- [ ] **Step 3: Add the publish job after the validation jobs**

Append this job to `.github/workflows/validate.yml`:

```yaml
  publish:
    name: Publish Homey Draft
    if: github.event_name == 'push' && github.ref == 'refs/heads/main'
    needs: [test, homey-validate, dependency-audit]
    runs-on: ubuntu-latest
    environment: homey-test
    steps:
      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
      - name: Publish Draft
        id: publish
        uses: athombv/github-action-homey-app-publish@0642b483f1eb66fbceb0c91b73df35d45fd2f3db
        with:
          personal_access_token: ${{ secrets.HOMEY_PAT }}
      - name: Add management URL to summary
        run: echo "Manage the Homey Draft at ${{ steps.publish.outputs.url }}" >> "$GITHUB_STEP_SUMMARY"
```

- [ ] **Step 4: Verify the workflow's security invariants**

Run:

```bash
rg -n "HOMEY_PAT|github.event_name == 'push'|refs/heads/main|needs:|environment: homey-test" .github/workflows/validate.yml
git diff --check
git grep -nE 'HOMEY_PAT[=:][[:space:]]*[^$]|Bearer [A-Za-z0-9._-]+|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'
```

Expected: `HOMEY_PAT` appears only as `${{ secrets.HOMEY_PAT }}` in the publish job; the gate, dependencies, and environment are present; whitespace check passes; the secret scan finds no credential values.

- [ ] **Step 5: Run full local verification again**

```bash
npm run lint
npm test
homey app validate --level publish
```

Expected: all commands exit zero and tests report 77 passing tests.

- [ ] **Step 6: Commit automatic publication**

```bash
git add .github/workflows/validate.yml .homeychangelog.json
git commit -m "ci: publish validated Homey drafts"
```

### Task 3: GitHub configuration and end-to-end delivery

**Files:**
- Modify through GitHub API: repository Actions secret `HOMEY_PAT` and environment `homey-test`.
- No repository file changes expected unless CI reveals a defect.

**Interfaces:**
- Consumes: user-generated Homey app-owner PAT and committed workflow.
- Produces: green pull-request checks, merged `main`, green `main` workflow, and uploaded Homey Draft.

- [ ] **Step 1: Configure the protected secret without displaying it**

Use GitHub's secret entry mechanism so the PAT is read from the terminal or local clipboard and never passed as a visible command argument:

```bash
gh secret set HOMEY_PAT --repo shejnowicz/homey-grohe-blue
```

Expected: GitHub confirms `HOMEY_PAT` was set; no token value appears in terminal history or logs.

- [ ] **Step 2: Create the deployment environment**

```bash
gh api --method PUT repos/shejnowicz/homey-grohe-blue/environments/homey-test
```

Expected: API response identifies the `homey-test` environment.

- [ ] **Step 3: Push an implementation branch and open a pull request**

```bash
git push -u origin feature/github-ci-homey-test
gh pr create --base main --head feature/github-ci-homey-test --title "ci: automate Homey validation and Draft publishing" --body "Adds CI checks and automatic Homey Draft publication after validated merges to main."
```

Expected: GitHub returns the new pull-request URL.

- [ ] **Step 4: Wait for pull-request validation**

```bash
gh pr checks --watch
```

Expected: `Test`, `Homey validate`, and `Dependency audit` all pass; `Publish Homey Draft` is skipped for the pull request.

- [ ] **Step 5: Merge only after all checks pass**

```bash
gh pr merge --squash --delete-branch
```

Expected: the pull request is merged into `main` and its remote branch is deleted.

- [ ] **Step 6: Verify the automatic publication run**

```bash
gh run list --branch main --limit 1
gh run watch
```

Expected: all validation jobs and `Publish Homey Draft` pass; the job summary contains the Homey Developer Tools management URL.

- [ ] **Step 7: Enable and test the Draft**

Open the management URL from the job summary, enable version `0.0.1` for Test, then install it through its Homey Test URL. Confirm pairing, status refresh, and both automatic-flushing Flow cards. Do not submit the app for certification and do not publish it to Live.
