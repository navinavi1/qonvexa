const fs=require('node:fs');
const path=require('node:path');
async function runWorkflow(request,launchBrowser,{workDir='/home/user'}={}){
 const origin=new URL(request.url).origin,browser=await launchBrowser();
 try{
  const stateFile=path.join(workDir,'browser-session.json');
  const context=await browser.newContext(fs.existsSync(stateFile)?{storageState:stateFile}:{});
  let page;
  await context.route('**/*',async route=>{
   const r=route.request(),url=new URL(r.url());
   if(r.isNavigationRequest()&&page&&r.frame()===page.mainFrame()&&url.origin!==origin)return route.abort();
   return route.continue();
  });
  page=await context.newPage();await page.goto(request.url,{waitUntil:'domcontentloaded',timeout:25000});
  const results=[],downloads=[];
  for(const step of request.steps){
   if(new URL(page.url()).origin!==origin)throw Error('browser_origin_changed');
   const text=await page.locator('body').innerText();
   if(/verify you are human|complete the captcha|government id|enter (?:the )?(?:2fa|verification code)|confirm purchase|subscribe now/i.test(text))throw Error('OWNER_ACTION_REQUIRED');
   const target=step.selector?page.locator(step.selector):null;
   switch(step.action){
    case 'navigate': {const url=new URL(step.value,page.url());if(url.origin!==origin)throw Error('browser_origin_changed');await page.goto(url.href,{waitUntil:'domcontentloaded'});break;}
    case 'type':await target.fill(String(step.value||''));break;
    case 'click':await target.click({timeout:10000});break;
    case 'select':await target.selectOption(String(step.value||''));break;
    case 'upload':{const file=path.resolve(workDir,String(step.value||''));if(!file.startsWith(path.resolve(workDir)+'/')||/browser-session|browser-action|\.env|credentials|secrets/i.test(file))throw Error('invalid_upload_path');await target.setInputFiles(file);break;}
    case 'download':{const event=page.waitForEvent('download',{timeout:15000});await target.click();const file=await event;const targetPath=path.join(workDir,'browser-download-'+downloads.length);await file.saveAs(targetPath);downloads.push(targetPath);break;}
    case 'wait':await target.waitFor({state:'visible',timeout:10000});break;
    case 'extract':results.push({selector:step.selector,text:(step.attribute?await target.getAttribute(step.attribute):await target.innerText())?.slice(0,4000)||''});break;
    case 'screenshot':await page.screenshot({path:path.join(workDir,'browser-evidence.png')});break;
   }
  }
  if(new URL(page.url()).origin!==origin)throw Error('browser_origin_changed');
  await context.storageState({path:stateFile});fs.chmodSync(stateFile,0o600);
  return {ok:true,url:page.url(),results,downloads,externalConfirmation:results.map(x=>x.text).join('\n')};
 }finally{await browser.close();}
}
module.exports={runWorkflow};
if(require.main===module){const {launchBrowser}=require('/home/user/autonomos-browser.cjs');runWorkflow(JSON.parse(fs.readFileSync('/home/user/browser-action.json','utf8')),launchBrowser).then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1;});}
