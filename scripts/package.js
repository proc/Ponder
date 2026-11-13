// Packages Ponder as an app you can run without the source: builds the Go
// backend and the bundled engines, then puts them with the window's files
// and the piece sets into an Electron bundle under ./dist.
//
//   npm run package                 for this computer
//   npm run package -- --arch=x64   for another processor (arm64, x64)
//   npm run package -- --zip        also a .zip of it (macOS)
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const args = process.argv.slice(2);
const arch = args.find((a) => a.startsWith('--arch='))?.slice(7) || process.arch;
const zip = args.includes('--zip');
const goArch = { arm64: 'arm64', x64: 'amd64' }[arch];
if (!goArch) {
  console.error(`Unknown --arch=${arch}: use arm64 or x64.`);
  process.exit(1);
}

async function main() {
  // The backend and engines for the processor the package is for. They are
  // built apart from ./bin, which npm start uses (and may be running).
  const exe = process.platform === 'win32' ? '.exe' : '';
  const stage = path.join(root, 'dist', `.stage-${arch}`);
  const bin = path.join(stage, 'bin');
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(bin, { recursive: true });
  for (const [name, pkg] of [['backend', '.'], ['randomengine', './cmd/randomengine'], ['basicengine', './cmd/basicengine']]) {
    try {
      execFileSync('go', ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(bin, name + exe), pkg], {
        cwd: path.join(root, 'backend'), stdio: 'inherit', env: { ...process.env, GOARCH: goArch, CGO_ENABLED: '0' },
      });
    } catch (err) {
      if (err.code === 'ENOENT') console.error('Go was not found on your PATH. Install it from https://go.dev/dl/ and try again.');
      process.exit(1);
    }
    console.log('built', name, `(${arch})`);
  }

  let packager, electronVersion;
  try {
    ({ packager } = await import('@electron/packager'));
    electronVersion = require('electron/package.json').version;
  } catch {
    console.error('Run "npm install" first: packaging needs electron and @electron/packager.');
    process.exit(1);
  }

  // Only the app itself goes into the bundle; the backend and the piece
  // sets sit beside it in Resources, where main.js looks for them.
  const keep = (file) => file === '' || file === '/package.json' || file === '/app' || file.startsWith('/app/');
  const [out] = await packager({
    dir: root,
    out: path.join(root, 'dist'),
    name: 'Ponder',
    icon: path.join(root, 'assets', 'icon'), // .icns or .ico, by platform
    appBundleId: 'org.ponder.chess',
    appCategoryType: 'public.app-category.board-games',
    platform: process.platform,
    arch,
    electronVersion,
    overwrite: true,
    asar: true,
    prune: false,
    ignore: (file) => !keep(file) || file.endsWith('.DS_Store'),
    extraResource: [bin, path.join(root, 'svg')],
  });
  fs.rmSync(stage, { recursive: true, force: true });
  for (const junk of ['svg/.DS_Store']) {
    for (const res of [path.join(out, 'Ponder.app', 'Contents', 'Resources'), path.join(out, 'resources')]) {
      fs.rmSync(path.join(res, junk), { force: true });
    }
  }
  if (process.platform === 'darwin') {
    // Sign the finished bundle for this computer (ad hoc: no developer
    // identity). Without it macOS finds the bundle changed since Electron
    // was signed. To hand the app to others, sign and notarize it instead.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', path.join(out, 'Ponder.app')], { stdio: 'inherit' });
  }
  console.log('packaged', path.relative(root, out));

  if (zip && process.platform === 'darwin') {
    const { version } = require(path.join(root, 'package.json'));
    const file = path.join(root, 'dist', `Ponder-${version}-mac-${arch}.zip`);
    fs.rmSync(file, { force: true });
    execFileSync('ditto', ['-c', '-k', '--keepParent', path.join(out, 'Ponder.app'), file], { stdio: 'inherit' });
    console.log('zipped', path.relative(root, file));
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
