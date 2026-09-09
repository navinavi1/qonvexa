const assert=require('node:assert/strict'),http=require('node:http'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runWorkflow}=require('../src/autonomos/browser-workflow.cjs');
const {launchBrowser}=require('../src/autonomos/browser-runtime.cjs');
(async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'browser-workflow-'));
 const server=http.createServer((req,res)=>{
  if(req.url==='/download'){res.writeHead(200,{'content-disposition':'attachment; filename="result.csv"'});res.end('name,result\nfixture,verified\n');return;}
  res.setHeader('content-type','text/html');
  if(req.url==='/receipt'){res.end('<div id="receipt" data-id="receipt-17">'+(req.headers.cookie?.includes('session=verified')?'receipt-17':'missing-session')+'</div><a id="download" href="/download">Download</a>');return;}
  res.end('<input id="name"><select id="kind"><option value="data">Data</option></select><input type="file" id="file"><button id="submit" onclick="document.cookie=\'session=\'+document.querySelector(\'#name\').value+\';path=/\';location.href=\'/receipt\'">Submit</button>');
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const url='http://127.0.0.1:'+server.address().port;
 try{
  fs.writeFileSync(path.join(root,'input.csv'),'fixture');
  const first=await runWorkflow({url,steps:[{action:'type',selector:'#name',value:'verified'},{action:'select',selector:'#kind',value:'data'},{action:'upload',selector:'#file',value:'input.csv'},{action:'click',selector:'#submit'},{action:'wait',selector:'#receipt'},{action:'extract',selector:'#receipt',attribute:'data-id'},{action:'download',selector:'#download'},{action:'screenshot'}]},launchBrowser,{workDir:root});
  assert.equal(first.externalConfirmation,'receipt-17');assert.match(fs.readFileSync(first.downloads[0],'utf8'),/fixture,verified/);assert(fs.statSync(path.join(root,'browser-evidence.png')).size>100);
  const restored=await runWorkflow({url:url+'/receipt',steps:[{action:'extract',selector:'#receipt'}]},launchBrowser,{workDir:root});assert.equal(restored.externalConfirmation,'receipt-17');
  await assert.rejects(runWorkflow({url,steps:[{action:'navigate',value:'https://other.invalid'}]},launchBrowser,{workDir:root}),/origin_changed/);
  console.log('BROWSER WORKFLOW: actual Chromium upload, select, submit, receipt, download, screenshot, restored cookie session and origin restriction PASS');
 }finally{await new Promise(resolve=>server.close(resolve));fs.rmSync(root,{recursive:true,force:true});}
})().catch(e=>{console.error(e);process.exitCode=1;});
