import test from "node:test";
import assert from "node:assert/strict";
import {deployFailure} from "../scripts/deploy-errors.mjs";
test("deployment diagnostics classify setup failures without leaking upstream text",()=>{
  const secret="sentinel-private-provider-credential";
  assert.equal(deployFailure(`Authentication error ${secret} [code: 10000]`),"DEPLOY_AUTH_FAILED API_CODE_10000");
  assert.equal(deployFailure(`Register a workers.dev subdomain ${secret}`),"DEPLOY_SUBDOMAIN_REQUIRED");
  assert.equal(deployFailure(`Zone is not active ${secret}`),"DEPLOY_DOMAIN_NOT_READY");
  assert.equal(deployFailure(`A CNAME record already exists ${secret}`),"DEPLOY_DNS_CONFLICT");
  assert.equal(deployFailure(secret),"DEPLOY_COMMAND_FAILED");
});
