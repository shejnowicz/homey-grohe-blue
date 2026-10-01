'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const repositoryRoot = join(__dirname, '..');
const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'validate.yml'), 'utf8');

// Returns the YAML lines of one job, from its `  <name>:` header up to the next
// job header, so an assertion cannot accidentally be satisfied by another job.
function jobBlock(name) {
  const lines = workflow.split('\n');
  const start = lines.indexOf(`  ${name}:`);
  assert.notEqual(start, -1, `the workflow has no "${name}" job`);
  let end = start + 1;
  while (end < lines.length && !/^ {2}\S/.test(lines[end])) {
    end += 1;
  }
  return lines.slice(start, end).join('\n');
}

test('publishes only version changes pushed to main', () => {
  assert.match(workflow, /^\s{2}release:\s*$/m);
  assert.match(workflow, /github\.event_name == 'push'.*refs\/heads\/main/);
  assert.match(workflow, /git show .*\.homeycompose\/app\.json/);
  assert.match(workflow, /needs\.release\.outputs\.changed == 'true'/);
  assert.match(workflow, /needs: \[test, homey-validate, dependency-audit, release\]/);
  assert.match(workflow, /personal_access_token:\s*\$\{\{ secrets\.HOMEY_PAT \}\}/);
});

test('keeps the publish job gated on the same jobs and environment', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /^ {4}if: needs\.release\.outputs\.changed == 'true'$/m);
  assert.match(publish, /^ {4}needs: \[test, homey-validate, dependency-audit, release\]$/m);
  assert.match(publish, /^ {4}environment: homey-test$/m);
});

test('grants the publish job issue write access and nothing wider', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /^ {4}permissions:\n {6}contents: read\n {6}issues: write$/m);
  // The workflow-wide default stays read-only.
  assert.match(workflow, /^permissions:\n {2}contents: read$/m);
});

test('reports the waiting draft in the job summary', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /version=\$\(node -p "require\('\.\/\.homeycompose\/app\.json'\)\.version"\)/);
  assert.match(publish, /VERSION: \$\{\{ steps\.app\.outputs\.version \}\}/);
  assert.match(publish, /DRAFT_URL: \$\{\{ steps\.publish\.outputs\.url \}\}/);
  assert.match(publish, />> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(publish, /promote this draft to the Test channel/);
});

test('opens a promotion reminder issue with the workflow token', () => {
  const publish = jobBlock('publish');
  assert.match(publish, /GH_TOKEN: \$\{\{ github\.token \}\}/);
  assert.match(publish, /gh label create release [^\n]*\\\n[^\n]*\|\| true/);
  assert.match(publish, /gh issue create/);
  assert.match(publish, /--title "Promote GROHE Blue \$\{VERSION\} to Test"/);
  assert.match(publish, /--label release/);
  assert.match(publish, /COMMIT_SHA: \$\{\{ github\.sha \}\}/);
  // A failed issue must not fail an otherwise successful publish.
  assert.match(publish, /--body-file "\$\{body\}" \\\n\s*\|\| echo "::warning::/);
});

test('makes the Homey push optional and unable to fail the job', () => {
  const publish = jobBlock('publish');
  // The secret is only read to decide whether the push runs ...
  assert.match(publish, /HOMEY_WEBHOOK_URL: \$\{\{ secrets\.HOMEY_WEBHOOK_URL \}\}/);
  assert.match(publish, /if \[ -n "\$\{HOMEY_WEBHOOK_URL\}" \]; then/);
  assert.match(publish, /echo "configured=true" >> "\$GITHUB_OUTPUT"/);
  // ... and the push itself is skipped when the secret is absent.
  assert.match(publish, /^ {8}if: steps\.homey_push\.outputs\.configured == 'true'$/m);
  assert.match(publish, /--data-urlencode "event=grohe-draft"/);
  assert.match(publish, /--data-urlencode "tag=\$\{VERSION\} \$\{DRAFT_URL\}"/);
  assert.match(publish, /--max-time 20/);
  assert.match(publish, /"\$\{HOMEY_WEBHOOK_URL\}" \|\| true/);
  // The Homey flow behind the webhook is documented next to the step.
  assert.match(publish, /event `grohe-draft`/);
});

test('never commits a Homey webhook URL', () => {
  // The placeholder "<id>" in the workflow comment is fine; a real id is not.
  const webhookWithId = /webhooks\.athom\.com\/webhook\/[A-Za-z0-9_-]{6,}/;
  const trackedFiles = execFileSync('git', ['ls-files', '-z'], { cwd: repositoryRoot })
    .toString()
    .split('\0')
    .filter(Boolean)
    .filter((file) => !file.startsWith('assets/'));

  assert.ok(trackedFiles.length > 0, 'expected tracked files to scan');
  for (const file of trackedFiles) {
    const contents = readFileSync(join(repositoryRoot, file), 'utf8');
    assert.ok(!webhookWithId.test(contents), `${file} looks like it carries a Homey webhook URL`);
  }
});
