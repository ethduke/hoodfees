import {readFile,readdir} from "node:fs/promises";
import path from "node:path";
async function walk(root){const files=[];for(const item of await readdir(root,{withFileTypes:true})){const file=path.join(root,item.name);if(item.isDirectory())files.push(...await walk(file));else files.push(file);}return files;}
try{
  const files=await walk("dist");
  const forbidden=["ROBINHOOD_RPC_URL","O1_API_KEY","BAGS_API_KEY","SCAN_CURSOR_SECRET"].map(key=>process.env[key]).filter(value=>typeof value==="string"&&value.length>=8);
  for(const file of files){const bytes=await readFile(file);if(forbidden.some(value=>bytes.includes(Buffer.from(value))))throw Error();}
  process.stdout.write("WORKER_BUNDLE_CHECK_PASSED\n");
}catch{process.stderr.write("WORKER_BUNDLE_CHECK_FAILED\n");process.exitCode=1;}
