// Launches Chromium in a Vercel serverless function using @sparticuz/chromium
// (a Lambda-compatible build) + playwright-core.
//
// On Vercel's runtime, @sparticuz/chromium inflates the graphics (swiftshader)
// libs but NOT the NSS/system library pack (al2023.tar.br), so Chromium can't
// find libnss3.so. We inflate that pack ourselves (brotli + a tiny tar reader,
// no extra deps) into /tmp and put /tmp on LD_LIBRARY_PATH.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function safeList(dir) {
  try { return fs.readdirSync(dir).slice(0, 80); } catch (e) { return `(cannot read ${dir}: ${e.code || e.message})`; }
}

// Minimal USTAR extractor (regular files, dirs, symlinks).
function untar(buf, dest) {
  let off = 0;
  while (off + 512 <= buf.length) {
    const h = buf.subarray(off, off + 512);
    // end-of-archive: a zero block
    if (h.every((b) => b === 0)) break;
    const name = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8) || 0;
    const type = String.fromCharCode(h[156]);
    const linkname = h.subarray(157, 257).toString('utf8').replace(/\0.*$/, '');
    off += 512;
    const data = buf.subarray(off, off + size);
    off += Math.ceil(size / 512) * 512;
    if (!fullName) continue;
    const out = path.join(dest, fullName);
    try {
      if (type === '5') { fs.mkdirSync(out, { recursive: true }); continue; }
      fs.mkdirSync(path.dirname(out), { recursive: true });
      if (type === '2' || type === '1') { try { fs.symlinkSync(linkname, out); } catch {} continue; }
      fs.writeFileSync(out, data);
    } catch { /* keep going */ }
  }
}

function ensureNssLibs(pkgBinDir) {
  const here = () => ['/tmp/libnss3.so', '/tmp/lib/libnss3.so'].some((p) => { try { return fs.existsSync(p); } catch { return false; } });
  if (here()) return 'already-present';
  for (const pack of ['al2023.tar.br', 'al2.tar.br']) {
    const br = path.join(pkgBinDir, pack);
    try {
      if (!fs.existsSync(br)) continue;
      const tarBuf = zlib.brotliDecompressSync(fs.readFileSync(br));
      untar(tarBuf, '/tmp');
      if (here()) return 'extracted:' + pack;
    } catch (e) { /* try next pack */ }
  }
  return 'not-extracted';
}

async function launchBrowser() {
  const isServerless = !!(process.env.VERCEL || process.env.AWS_LAMBDA_FUNCTION_NAME);
  const { chromium } = require('playwright-core');

  if (isServerless) {
    const sparticuz = require('@sparticuz/chromium');
    const executablePath = await sparticuz.executablePath();

    const pkgBinDir = path.join(process.cwd(), 'node_modules/@sparticuz/chromium/bin');
    const nss = ensureNssLibs(pkgBinDir);

    const libDirs = ['/tmp', '/tmp/lib'].filter((p) => { try { return fs.existsSync(p); } catch { return false; } });
    process.env.LD_LIBRARY_PATH = [...libDirs, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
    process.env.HOME = process.env.HOME || '/tmp';

    const diag = {
      nss,
      LD_LIBRARY_PATH: process.env.LD_LIBRARY_PATH,
      hasLibnss_tmp: (() => { try { return fs.existsSync('/tmp/libnss3.so'); } catch { return false; } })(),
      hasLibnss_tmplib: (() => { try { return fs.existsSync('/tmp/lib/libnss3.so'); } catch { return false; } })(),
      tmp: safeList('/tmp'),
    };
    console.log('[chromium diag]', JSON.stringify(diag));

    // Playwright (unlike Puppeteer) does NOT work with Chromium's --single-process;
    // it makes the browser close as soon as the page does real work. Strip it.
    const GL_FLAGS = ['--use-gl=', '--use-angle=', '--enable-unsafe-swiftshader', '--in-process-gpu', '--ignore-gpu-blocklist'];
    const args = sparticuz.args.filter((a) => a !== '--single-process' && !GL_FLAGS.some((f) => a.startsWith(f)));
    try {
      return await chromium.launch({
        args: [...args, '--no-sandbox', '--disable-dev-shm-usage', '--disable-remote-fonts', '--disable-gpu', '--disable-accelerated-2d-canvas', '--disable-webgl'],
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
