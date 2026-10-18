import {spawn} from "node:child_process";
const child=spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","deploy","--config","dist/server/wrangler.json"],{
  stdio:["ignore","pipe","pipe"],env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_WRITE_LOGS:"false",WRANGLER_LOG_PATH:".wrangler/logs"},
});
// Deployment diagnostics are fixed codes; CLI output can include configuration.
child.stdout.resume();child.stderr.resume();
child.on("error",()=>{process.stderr.write("DEPLOY_COMMAND_FAILED\n");process.exitCode=1;});
child.on("exit",code=>{if(code){process.stderr.write("DEPLOY_COMMAND_FAILED\n");process.exitCode=1;}else process.stdout.write("DEPLOY_COMMAND_SUCCEEDED\n");});
