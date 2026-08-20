const { execFileSync } = require('node:child_process');

function trackedJavaScriptFiles(listFiles = () => execFileSync(
  'git',
  ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
)) {
  return listFiles()
    .toString()
    .split('\0')
    .filter((file) => file.endsWith('.js'))
    .filter((file) => !file.startsWith('node_modules/'))
    .filter((file) => !file.startsWith('.homeybuild/'));
}

function checkJavaScriptFiles(files, check = execFileSync) {
  for (const file of files) {
    check(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}

if (require.main === module) {
  checkJavaScriptFiles(trackedJavaScriptFiles());
}

module.exports = { checkJavaScriptFiles, trackedJavaScriptFiles };
