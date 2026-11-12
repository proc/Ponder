// Builds the Go backend and the bundled random-move engine into ./bin.
const { execFileSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const exe = process.platform === 'win32' ? '.exe' : '';
const targets = [
  ['backend', '.'],
  ['randomengine', './cmd/randomengine'],
  ['basicengine', './cmd/basicengine'],
];

for (const [name, pkg] of targets) {
  const out = path.join(root, 'bin', name + exe);
  try {
    execFileSync('go', ['build', '-o', out, pkg], {
      cwd: path.join(root, 'backend'),
      stdio: 'inherit',
    });
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error('Go was not found on your PATH. Install it from https://go.dev/dl/ and try again.');
    }
    process.exit(1);
  }
  console.log('built', path.relative(root, out));
}
