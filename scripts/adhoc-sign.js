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

  // Skip the per-architecture staging directories of a universal build.
  //
  // electron-builder packs x64 and arm64 into mac-universal-x64-temp and
  // mac-universal-arm64-temp, calls this hook for EACH, then merges them with
  // @electron/universal. That merge requires every non-binary file to be
  // byte-identical between the two halves — and signing produces a different
  // _CodeSignature/CodeResources in each, so signing the halves broke the
  // merge outright:
  //
  //   ⨯ Expected all non-binary files to have identical SHAs when creating a
  //     universal build but "Contents/Frameworks/Electron Framework.framework/
  //     Versions/A/_CodeSignature/CodeResources" did not
  //
  // The merged bundle gets its own afterPack call afterwards — see
  // app-builder-lib/out/macPackager.js, "Give users a final opportunity to
  // perform things on the combined universal package before signing" — so
  // bailing out here still leaves the shipped artifact signed, and signed
  // once, covering both architectures.
  if (/-temp$/.test(context.appOutDir)) {
    console.log(`  • skipping ad-hoc signing of ${path.basename(context.appOutDir)} (universal staging dir)`);
    return;
  }

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
