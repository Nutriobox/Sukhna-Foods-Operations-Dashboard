// Launches Chromium in a Vercel serverless function using @sparticuz/chromium
// (a Lambda-compatible build) + playwright-core. Locally (non-Vercel) it falls
// back to a normal playwright-core launch so you can run it on a dev machine.
const path = require('path');

async function launchBrowser() {
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const { chromium } = require('playwright-core');

  if (isServerless) {
    const sparticuz = require('@sparticuz/chromium');
    const executablePath = await sparticuz.executablePath();
    return chromium.launch({
      args: [...sparticuz.args, '--no-sandbox', '--disable-dev-shm-usage'],
      executablePath,
      headless: true,
    });
  }
  // local/dev fallback — use a system Chrome/Chromium if present
  return chromium.launch({ headless: true });
}

module.exports = { launchBrowser };
