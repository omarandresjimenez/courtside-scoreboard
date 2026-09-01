// electron-builder `afterSign` hook.
//
// With no Developer ID identity available, electron-builder skips its own
// signing step entirely (see `mac.identity: null` in package.json's build
// config) — but the *prebuilt* Electron.app binary it repackages already
// carries its own baked-in ad-hoc signature from Electron's own build.
// Copying `extraResources` (template.db, the server, node_modules, ...)
// into Contents/Resources happens *after* that signature was applied, which
// invalidates its resource seal without replacing it.
//
// The result: `spctl --assess` reports "code has no resources but
// signature indicates they must be present" — not the ordinary "rejected
// (unsigned)" verdict a user can get past with right-click → Open, but a
// genuinely broken signature that refuses to launch at all, silently, with
// no window and no error. This was found by trying to actually launch a
// freshly built .app, not by reading the config.
//
// Re-signing ad-hoc ourselves reseals the resources against what's
// actually on disk now, producing a normal, launchable unsigned app.
const { execFileSync } = require('node:child_process');
const path = require('node:path');

module.exports = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], {
    stdio: 'inherit',
  });
};
