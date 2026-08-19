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
if (!server.includes("app.listen(port, '0.0.0.0'")) {
  throw new Error('Server must bind explicitly to 0.0.0.0 on Render.');
}
if (!String(pkg.engines?.node || '').includes('<25')) {
  throw new Error('Node engine must have an upper bound to prevent unexpected major upgrades.');
}
console.log('Render route/deployment audit passed.');
