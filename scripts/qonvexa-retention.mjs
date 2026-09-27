import 'dotenv/config';import path from 'node:path';import {Store} from '../src/qonvexa/store.js';import {config} from '../src/qonvexa/config.js';import {pruneTemporary} from '../src/qonvexa/retention.js';
if(!process.argv.includes('--apply')){console.log('Preview only. Use --apply against an explicitly selected local STORAGE_DIR after backup. No data changed.');process.exit(0);}
const store=new Store(path.resolve(process.env.STORAGE_DIR||'data'));console.log(pruneTemporary(store,config()));store.close();
