import {spawn} from "node:child_process";
const child=spawn(process.execPath,["node_modules/wrangler/bin/wrangler.js","dev","--config","dist/server/wrangler.json","--local","--ip","127.0.0.1","--port","3010","--inspector-port","0"],{
  stdio:"inherit",env:{...process.env,WRANGLER_SEND_METRICS:"false",WRANGLER_WRITE_LOGS:"false",WRANGLER_LOG_PATH:".wrangler/logs"},
});
child.on("exit",code=>{process.exitCode=code??1;});
for(const signal of ["SIGINT","SIGTERM"])process.on(signal,()=>child.kill(signal));
