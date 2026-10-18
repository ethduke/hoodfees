import {spawn} from "node:child_process";
const child=spawn("npm",["audit","--json"],{stdio:["ignore","pipe","pipe"]});
let output="";
child.stdout.on("data",data=>{output+=data;if(output.length>5_000_000)child.kill();});
child.stderr.resume();
child.on("error",()=>{process.stderr.write("DEPENDENCY_AUDIT_FAILED\n");process.exitCode=1;});
child.on("exit",()=>{
  try{
    const audit=JSON.parse(output), counts=audit.metadata.vulnerabilities;
    process.stdout.write(JSON.stringify({info:counts.info,low:counts.low,moderate:counts.moderate,high:counts.high,critical:counts.critical})+"\n");
    if(counts.high||counts.critical)process.exitCode=1;
  }catch{process.stderr.write("DEPENDENCY_AUDIT_FAILED\n");process.exitCode=1;}
});
