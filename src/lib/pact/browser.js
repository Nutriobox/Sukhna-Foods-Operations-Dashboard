// Launches Chromium in a Vercel serverless function using @sparticuz/chromium
// (a Lambda-compatible build) + playwright-core. Includes diagnostics so we can
// see where the shared libraries land if the launch fails.
const fs = require('fs');

function safeList(dir) {
  try { return fs.readdirSync(dir).slice(0, 60); } catch (e) { return `(cannot read ${dir}: ${e.code || e.message})`; }
}

async function launchBrowser() {
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const { chromium } = require('playwright-core');

  if (isServerless) {
    const sparticuz = require('@sparticuz/chromium');
    const executablePath = await sparticuz.executablePath();

    // Make sure the loader can find the extracted .so files (libnss3, etc.).
    const candidates = ['/tmp', '/tmp/lib', '/tmp/al2', '/tmp/al2023'].filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    process.env.LD_LIBRARY_PATH = [...candidates, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');

    const diag = {
      executablePath,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      tmp: safeList('/tmp'),
      pkgBin: safeList(require('path').join(process.cwd(), 'node_modules/@sparticuz/chromium/bin')),
      hasLibnss_tmp: (() => { try { return fs.existsSync('/tmp/libnss3.so'); } catch { return false; } })(),
    };
    console.log('[chromium diag]', JSON.stringify(diag));

    try {
      return await chromium.launch({
        args: [...sparticuz.args, '--no-sandbox', '--disable-dev-shm-usage'],
        executablePath,
        headless: true,
      });
    } catch (e) {
      throw new Error(String(e && e.message ? e.message : e).split('\n')[0] + '  ||DIAG|| ' + JSON.stringify(diag));
    }
  }
  return chromium.launch({ headless: true });
}

module.exports = { launchBrowser };
