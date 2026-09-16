import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const requiredPublic = ['index.html','styles.css','app.js','admin.html','admin.js','admin.css'];
const missing = requiredPublic.filter(f => !fs.existsSync(path.join(root,'public',f)));
if (missing.length) throw new Error(`Missing public files: ${missing.join(', ')}`);

const rootRoute = server.indexOf("for (const route of ['/', '/index.html'])");
const robotsRoute = server.indexOf("app.get('/robots.txt'");
const adminRoute = server.indexOf("app.get('/admin'");
const staticMiddleware = server.indexOf('app.use(express.static(publicDir');
if ([rootRoute, robotsRoute, adminRoute, staticMiddleware].some(x => x < 0)) {
  throw new Error('Required Render/Express routes were not found.');
}
if (!(rootRoute < staticMiddleware && robotsRoute < staticMiddleware && adminRoute < staticMiddleware)) {
  throw new Error('Route ordering invalid: explicit routes must be registered before express.static.');
}

// Not a style rule here but a security one. AutonomOS writes the global work feed and the
// daily money report -- revenue, fees, costs, net profit, the owner/agent split and the whole
// job pipeline -- as files inside publicDir. If their authenticated route is ever registered
// after express.static, the static handler answers first and the owner's books go back to
// being readable by anyone who guesses the filename.
const privateViewRoute = server.indexOf('autonomos-(?:global-feed|money-report)');
if (privateViewRoute < 0) {
  throw new Error('The authenticated route for the generated money/feed views is missing: those files sit in publicDir and would be served to anyone.');
}
if (!(privateViewRoute < staticMiddleware)) {
  throw new Error('The money/feed views must be routed before express.static, or the static handler serves them unauthenticated.');
}
if (!/autonomos-\(\?:global-feed\|money-report\)[^\n]*requireAdmin/.test(server)) {
  throw new Error('The money/feed views must be behind requireAdmin.');
}

// CI installs the version in .node-version; Render builds with NODE_VERSION from render.yaml.
// Two files, one answer -- and the whole reason a deploy can go red on a machine where the
// tests were green is a difference nobody was looking at. They have to say the same thing.
try {
  const pinnedInYaml = /NODE_VERSION[\s\S]{0,40}?value:\s*"?([0-9.]+)/.exec(fs.readFileSync(path.join(root, 'render.yaml'), 'utf8'))?.[1];
  const pinnedForCi = fs.readFileSync(path.join(root, '.node-version'), 'utf8').trim();
  if (pinnedInYaml && pinnedForCi && pinnedInYaml !== pinnedForCi) {
    throw new Error(`Node version split: .node-version says ${pinnedForCi}, render.yaml says ${pinnedInYaml}. CI would test one and the deploy would build the other.`);
  }
} catch (error) {
  if (/Node version split/.test(String(error.message))) throw error;
}

// Two deploys were lost to code that behaved differently on the build machine than on mine.
// The Node version is the remaining difference nothing else would surface: render.yaml pins
// what actually runs the build, and a local run on another major is testing something else.
// A warning, not a failure -- local work on another version is legitimate, being unaware of
// it is what is not.
try {
  const renderYaml = fs.readFileSync(path.join(root, 'render.yaml'), 'utf8');
  const pinned = /NODE_VERSION[\s\S]{0,40}?value:\s*"?(\d+)/.exec(renderYaml)?.[1];
  const running = process.versions.node.split('.')[0];
  if (pinned && pinned !== running) {
    console.warn(`WARNING: this run is on Node ${running}; the deploy builds on Node ${pinned} (render.yaml). Anything version-specific will not be caught here.`);
  }
} catch {}
if (!server.includes("app.listen(port, '0.0.0.0'")) {
  throw new Error('Server must bind explicitly to 0.0.0.0 on Render.');
}
if (!String(pkg.engines?.node || '').includes('<25')) {
  throw new Error('Node engine must have an upper bound to prevent unexpected major upgrades.');
}
const blueprint = fs.readFileSync(path.join(root,'render.yaml'),'utf8');
if(!blueprint.includes('npm ci --include=dev && npm run verify && npm prune --omit=dev'))throw new Error('Build must install verification dependencies before testing, then remove dev dependencies.');
console.log('Render route/deployment audit passed.');
