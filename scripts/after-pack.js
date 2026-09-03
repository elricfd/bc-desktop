const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterPack(context) {
    if (context.electronPlatformName !== 'darwin') return;
    if (process.env.CSC_LINK || process.env.CSC_NAME || process.env.CSC_IDENTITY_AUTO_DISCOVERY === 'true') {
        console.log('[after-pack] certificate configured; leaving signing to electron-builder');
        return;
    }
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    console.log(`[after-pack] no certificate; ad-hoc signing ${app}`);
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
    execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=2', app], { stdio: 'inherit' });
};
