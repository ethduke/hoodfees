import {spawn} from "node:child_process";
import {deployFailure} from "./deploy-errors.mjs";
const child=spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","deploy","--config","dist/server/wrangler.json"],{
  stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_WRITE_LOGS:"false",WRANGLER_LOG_PATH:".wrangler/logs"},
});
let diagnostics="";
// Keep a bounded in-memory tail solely to map to fixed diagnostics.
for(const stream of [child.stdout,child.stderr])stream.on("data",chunk=>{diagnostics=(diagnostics+chunk.toString()).slice(-131072);});
child.on("error",()=>{process.stderr.write("DEPLOY_COMMAND_FAILED\n");process.exitCode=1;});
child.on("exit",code=>{if(code){process.stderr.write(deployFailure(diagnostics)+"\n");process.exitCode=1;}else process.stdout.write("DEPLOY_COMMAND_SUCCEEDED\n");diagnostics="";});
