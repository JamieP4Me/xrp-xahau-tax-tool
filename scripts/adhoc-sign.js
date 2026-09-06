/**
 * electron-builder `afterPack` hook: ad-hoc sign the macOS app bundle.
 *
 * WHY THIS EXISTS
 *
 * With no signature at all, a downloaded macOS app does not produce the
 * familiar "unidentified developer" prompt. It produces:
 *
 *     "XRP & Xahau Tax Tool.app" is damaged and can't be opened.
 *      You should move it to the Trash.
 *
 * which is both alarming and misleading — the download is fine. Worse, the
 * usual escape hatch does not work: right-click → Open bypasses the
 * unidentified-developer prompt, but it does NOT bypass "damaged". A user who
 * follows the normal advice ends up stuck, and the honest-looking conclusion
 * is that the author shipped a broken binary.
 *
 * The app runs fine when built locally because quarantine is only applied to
 * downloaded files, which is exactly why this does not show up until someone
 * else tries it.
 *
 * Ad-hoc signing (identity "-") does not make the app trusted — only a paid
 * Developer ID plus notarisation does that. What it does is give the bundle a
 * valid signature, so Gatekeeper reports the truthful "unidentified
 * developer" and right-click → Open works as documented. That is the
 * difference between a user who can run the app and one who deletes it.
 *
 * On Apple Silicon this is not optional in the same way: arm64 requires every
 * binary to carry at least an ad-hoc signature to execute at all.
 */
'use strict';

const path = require('path');
const { execFileSync } = require('child_process');

exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  // --deep is deprecated for real distribution signing, where each nested
  // binary should be signed in dependency order. For an ad-hoc signature it
  // is the pragmatic choice: it covers Electron's framework and helper apps
  // in one pass, and there is no certificate chain for it to get wrong.
  console.log(`  • ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'inherit' });

  // Fail the build rather than ship something that will read as "damaged".
  execFileSync('codesign', ['--verify', '--verbose=2', appPath], { stdio: 'inherit' });
  console.log('  • ad-hoc signature verified');
};
