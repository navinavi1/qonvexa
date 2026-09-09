// Free Chromium + bundled Linux libraries. Runs only inside the existing E2B sandbox.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { brotliDecompressSync } = require('node:zlib');
const { execFileSync } = require('node:child_process');
const root = process.env.AUTONOMOS_BROWSER_CACHE || path.join(os.homedir(), '.cache/autonomos-browser-v3');
function modules() { return { playwright: require(path.join(root, 'node_modules/playwright-core')), chromium: fs.statSync(path.join(root, 'node_modules/@sparticuz/chromium/bin/chromium.br')).isFile() }; }
async function launchBrowser() {
  let packages;
  try { packages = modules(); } catch {
    fs.mkdirSync(root, { recursive: true });
    execFileSync('npm', ['install', '--prefix', root, '--ignore-scripts', '--no-audit', '--no-fund', '--registry', 'https://registry.npmjs.org', 'playwright-core@1.63.0', '@sparticuz/chromium@152.0.0'], { timeout: 120000, stdio: ['ignore', 'pipe', 'pipe'] });
    packages = modules();
  }
  const { playwright, chromium } = packages;
  const runtime = path.join(root, 'runtime');fs.mkdirSync(runtime,{recursive:true});
  const binary = path.join(runtime, 'chromium');
  if(!fs.existsSync(path.join(runtime, '.ready'))||!fs.existsSync(path.join(runtime,'al2023/lib/libexpat.so.1'))){
    const bin=path.join(root,'node_modules/@sparticuz/chromium/bin');
    // Keep ownership of extracted files. Serverless containers cannot chown to the
    // original package author's UID, even when their local process reports root.
    for(const name of ['fonts','swiftshader','al2023']){
      const dest=name==='swiftshader'?runtime:path.join(runtime,name);fs.mkdirSync(dest,{recursive:true});
      execFileSync('tar',['--no-same-owner','-xf','-','-C',dest],{input:brotliDecompressSync(fs.readFileSync(path.join(bin,name+'.tar.br'))),timeout:30000});
    }
    fs.writeFileSync(binary,brotliDecompressSync(fs.readFileSync(path.join(bin,'chromium.br'))),{mode:0o700});
    fs.writeFileSync(path.join(runtime,'.ready'),'152.0.0');
  }
  const xml=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;');
  fs.writeFileSync(path.join(runtime,'fonts','fonts.conf'),`<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${xml(path.join(runtime,'fonts','fonts'))}</dir><cachedir>${xml(path.join(runtime,'fonts-cache'))}</cachedir><config/></fontconfig>`);
  return playwright.chromium.launch({ executablePath: binary, env:{...process.env,FONTCONFIG_PATH:path.join(runtime,'fonts'),LD_LIBRARY_PATH:[path.join(runtime,'al2023/lib'),runtime,process.env.LD_LIBRARY_PATH].filter(Boolean).join(':')}, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage','--disable-gpu','--no-zygote'], headless: true, timeout: 30000 });
}
async function probe({network=false}={}) {
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.goto('data:text/html,'+encodeURIComponent('<title>AutonomOS probe</title><input id="name"><button onclick="document.title=document.querySelector(\'#name\').value">Verify</button>'));
    await page.locator('#name').fill('verified_browser');
    await page.getByRole('button', { name: 'Verify' }).click();
    if (await page.title() !== 'verified_browser') throw Error('browser_javascript_click_probe_failed');
    const screenshot = await page.screenshot();
    if (screenshot.length < 100) throw Error('browser_screenshot_probe_failed');
    if(network){const response=await page.goto('https://example.com',{waitUntil:'domcontentloaded',timeout:25000});if(!response||response.status()!==200||!await page.title())throw Error('browser_public_network_probe_failed');}
    console.log(JSON.stringify({ networkVerified:network, proof: 'verified_browser', version: browser.version(), javascript: true, form: true, click: true, screenshot: true }));
  } finally { await browser.close(); }
}
module.exports = { launchBrowser, probe };
if (require.main === module) probe({network:process.argv.includes('--network')}).catch(error => { console.error(String(error.stack || error)); if (error.stderr) console.error(String(error.stderr).slice(-6000)); process.exitCode = 1; });
