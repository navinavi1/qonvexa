import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTaskmarketClient, taskmarketHome, taskmarketBinary, taskmarketCliRoot } from '../src/autonomos/taskmarket.js';

const root=fs.mkdtempSync(path.join(os.tmpdir(),'tm-keystore-'));
let checks=0;
const ok=(c,l)=>{assert.ok(c,l);checks++;};
const eq=(a,b,l)=>{assert.deepEqual(a,b,l+' (got '+JSON.stringify(a)+')');checks++;};

// A stand-in that writes where the real CLI writes: os.homedir()/.taskmarket/keystore.json,
// a path the real binary hardcodes with no environment override of its own.
const bin=path.join(root,'fake-taskmarket');
fs.writeFileSync(bin,`#!/usr/bin/env node
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=path.join(os.homedir(),'.taskmarket');
fs.mkdirSync(dir,{recursive:true});
fs.writeFileSync(path.join(dir,'keystore.json'),JSON.stringify({address:'0xagent',createdAt:Date.now()}));
console.log(JSON.stringify({ok:true,data:{address:'0xagent',home:os.homedir()}}));
`,{mode:0o755});

const storage=path.join(root,'persistent-disk');
const env={AUTONOMOS_TASKMARKET_ENABLED:'true',AUTONOMOS_TASKMARKET_BIN:bin,STORAGE_DIR:storage};

// 1. The home resolves onto the persistent storage directory, not the container's $HOME.
const home=taskmarketHome(env);
ok(home.startsWith(storage),'the CLI home sits under STORAGE_DIR, got '+home);
ok(home!==os.homedir(),'and is not the ephemeral container home');
eq(taskmarketHome({AUTONOMOS_TASKMARKET_HOME:'/custom'}),'/custom','an explicit home wins');
eq(taskmarketHome({}),'','no storage means no home, rather than a silent default');

// 2. A real spawn writes the keystore onto the persistent path.
const client=createTaskmarketClient({env});
const result=await client.address();
eq(result.ok,true,'the CLI ran');
eq(result.data.home,home,'the child process saw the persistent home');
const keystore=path.join(home,'.taskmarket','keystore.json');
ok(fs.existsSync(keystore),'the keystore landed on the persistent disk at '+keystore);
eq(JSON.parse(fs.readFileSync(keystore,'utf8')).address,'0xagent','and holds the wallet');

// 3. The wallet survives a simulated redeploy: container gone, disk kept.
const before=fs.readFileSync(keystore,'utf8');
const redeployed=createTaskmarketClient({env:{...env}});
await redeployed.address();
eq(fs.readFileSync(keystore,'utf8').length>0,true,'the keystore still exists after a fresh client');
ok(JSON.parse(before).address===JSON.parse(fs.readFileSync(keystore,'utf8')).address,
  'the same wallet address survives, so settled USDC stays reachable');

// 4. Without a persistent home the client refuses instead of minting a throwaway wallet.
let spawned=0;
const noHome=createTaskmarketClient({env:{AUTONOMOS_TASKMARKET_ENABLED:'true',AUTONOMOS_TASKMARKET_BIN:bin},
  exec:async()=>{spawned++;return{code:0,stdout:'{"ok":true}',stderr:''};}});
const refused=await noHome.address();
eq(refused.error,'taskmarket_home_unset','a missing persistent home is refused');
eq(spawned,0,'and no process is spawned, so no disposable key is ever created');

// 5. The refusal surface is unchanged: money-out stays impossible.
eq((await client.call(['withdraw','1'])).blocked,true,'withdraw is still refused');
eq((await client.call(['wallet','set-withdrawal-address','0xa'])).blocked,true,'set-withdrawal-address is still refused');

// 6. The CLI is found on the mounted disk, so a deploy cannot take it away. A global install
//    during the build is wrapped against failure, which means a failed native compile leaves
//    the lane inert with nothing to show for it -- which is what happened in production.
{
  const diskEnv={STORAGE_DIR:path.join(root,'disk2')};
  eq(taskmarketBinary(diskEnv),'taskmarket','with nothing installed it falls back to PATH');
  const onDisk=path.join(taskmarketCliRoot(diskEnv),'node_modules','.bin','taskmarket');
  fs.mkdirSync(path.dirname(onDisk),{recursive:true});
  fs.writeFileSync(onDisk,'#!/bin/sh\necho ok\n',{mode:0o755});
  eq(taskmarketBinary(diskEnv),onDisk,'once installed on the disk it is preferred over PATH');
  ok(taskmarketBinary(diskEnv).startsWith(path.join(root,'disk2')),'and that path is on the mounted disk');
  eq(taskmarketBinary({...diskEnv,AUTONOMOS_TASKMARKET_BIN:'/explicit/tm'}),'/explicit/tm','an explicit binary still wins');
  eq(taskmarketCliRoot({}),'','no persistent location means no CLI root, rather than a container path');
}


fs.rmSync(root,{recursive:true,force:true});
console.log('taskmarket-keystore-test OK ('+checks+' checks)');
