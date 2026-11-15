// electron-builder afterPack hook. With no Apple Developer certificate, sign the app ad hoc:
// Apple Silicon refuses to run unsigned code, and a missing or broken signature makes macOS call the
// downloaded app "damaged" instead of offering "Open Anyway".
const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  if (process.env.CSC_LINK || process.env.CSC_NAME) return; // A real certificate is configured: let electron-builder sign.
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  console.log(`  • ad-hoc signing ${app}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
};
