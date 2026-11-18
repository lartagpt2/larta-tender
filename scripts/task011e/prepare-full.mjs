import { readFile } from 'node:fs/promises';
import { save, repo } from '../task008-gate-d/io.mjs';
import { resolve } from 'node:path';
let t = await readFile(resolve(repo, 'scripts/task011e/integration.mjs'), 'utf8');
t = "import {browserChecks} from './browser.mjs';\nimport {extended} from './acceptance-extended.mjs';\n" + t;
t = t
  .replace(
    "import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';",
    "import lifecycle from '../../apps/api/dist/lifecycle/lifecycle-repository.js';\nimport stages from '../../apps/api/dist/stages/stage-repository.js';",
  )
  .replace(
    '        lifecycleEnabled: true,',
    '        stageRepository: new stages.PgStageRepository(pool),\n        lifecycleEnabled: true,',
  );
t = t.replace(
  '  passed = true;',
  `  await extended({app,auth,run,pool,tender,receipt,company,supplier,lot,verificationBody,transfer,saved,classify,fixtures,make,upload,post,get,request,ro,foreign,until,base,count,ok});\n  await browserChecks({run,pool,tender,app,ro,token,policyBytes,make,get,base,post,until,ok});\n  passed = true;`,
);
await save(resolve(repo, 'scripts/task011e/acceptance-full.mjs'), t);
