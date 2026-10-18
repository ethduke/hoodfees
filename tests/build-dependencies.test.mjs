import test from "node:test";
import assert from "node:assert/strict";
import braces from "../vendor/braces/index.js";
test("patched build parser preserves ordinary glob expansion and compilation",()=>{
  assert.deepEqual(braces.expand("app/{api,page}.{ts,tsx}"),["app/api.ts","app/api.tsx","app/page.ts","app/page.tsx"]);
  assert.equal(braces.compile("{a,b}"),"(a|b)");
});
test("deep patterns, direct ASTs and cyclic ASTs are rejected before recursive consumers",()=>{
  const pattern="{".repeat(5000)+"a,b"+"}".repeat(5000);
  assert.throws(()=>braces.parse(pattern),RangeError);
  let ast={type:"text",value:"a"};for(let i=0;i<5000;i++)ast={type:"brace",nodes:[ast]};
  for(const operation of [braces.compile,braces.stringify,braces.expand])assert.throws(()=>operation(ast),RangeError);
  const cycle={type:"root",nodes:[]};cycle.nodes.push(cycle);
  assert.throws(()=>braces.stringify(cycle),RangeError);
});
