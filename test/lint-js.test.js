const test = require('node:test');
const assert = require('node:assert/strict');

const { trackedJavaScriptFiles, checkJavaScriptFiles } = require('../scripts/lint-js');

test('lint selection is NUL-safe, excludes generated trees, and checks every selected file', () => {
  const files = trackedJavaScriptFiles(() => Buffer.from([
    'app.js',
    'drivers/blue_home/device.js',
    'file with spaces.js',
    'README.md',
    'node_modules/dependency.js',
    '.homeybuild/generated.js',
    '',
  ].join('\0')));

  assert.deepEqual(files, [
    'app.js',
    'drivers/blue_home/device.js',
    'file with spaces.js',
  ]);
  const calls = [];
  checkJavaScriptFiles(files, (executable, args, options) => {
    calls.push({ executable, args, options });
  });

  assert.deepEqual(calls, [
    { executable: process.execPath, args: ['--check', '--', 'app.js'], options: { stdio: 'inherit' } },
    {
      executable: process.execPath,
      args: ['--check', '--', 'drivers/blue_home/device.js'],
      options: { stdio: 'inherit' },
    },
    {
      executable: process.execPath,
      args: ['--check', '--', 'file with spaces.js'],
      options: { stdio: 'inherit' },
    },
  ]);
});

test('leading-dash filenames are passed after the Node option separator', () => {
  const calls = [];
  checkJavaScriptFiles(['--eval=throw-new-Error.js'], (executable, args, options) => {
    calls.push({ executable, args, options });
  });

  assert.deepEqual(calls, [{
    executable: process.execPath,
    args: ['--check', '--', '--eval=throw-new-Error.js'],
    options: { stdio: 'inherit' },
  }]);
});
