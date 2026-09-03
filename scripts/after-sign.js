const { execFileSync } = require('child_process');
const path = require('path');

module.exports = async function afterSign(context) {
    if (context.electronPlatformName !== 'darwin') return;
    const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    try {
        execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'pipe' });
        return;
    } catch {
        console.log(`[after-sign] no valid signature on ${app}; applying an ad-hoc signature`);
    }
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
};
