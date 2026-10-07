'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');

const workflow = readFileSync(join(__dirname, '..', '.github', 'workflows', 'validate.yml'), 'utf8');

test('publishes only version changes pushed to main', () => {
  assert.match(workflow, /^\s{2}release:\s*$/m);
  assert.match(workflow, /github\.event_name == 'push'.*refs\/heads\/main/);
  assert.match(workflow, /git show .*\.homeycompose\/app\.json/);
  assert.match(workflow, /needs\.release\.outputs\.changed == 'true'/);
  assert.match(workflow, /needs: \[test, homey-validate, dependency-audit, release\]/);
  assert.match(workflow, /personal_access_token:\s*\$\{\{ secrets\.HOMEY_PAT \}\}/);
});
