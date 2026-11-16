// electron-builder afterPack hook: ad-hoc sign the macOS app.
// Releases are built without an Apple Developer ID (mac.identity = null), and macOS refuses to
// run unsigned code on Apple Silicon ("app is damaged"). An ad-hoc signature fixes that; users
// still confirm the first launch in System Settings > Privacy & Security because it is not
// notarized. Runs before the dmg/zip are made, so they contain the signed app.

const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
