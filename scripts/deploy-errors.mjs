// Allowlisted diagnostics only; provider output must never reach build logs.
export function deployFailure(output) {
  const text=String(output).toLowerCase();
  const rules=[
    [/workers\.dev[\s\S]*(?:register|subdomain|not configured)|(?:register|choose)[\s\S]*workers\.dev/,"DEPLOY_SUBDOMAIN_REQUIRED"],
    [/already[\s\S]*(?:dns record|cname)|(?:dns record|cname)[\s\S]*already|conflicting dns/,"DEPLOY_DNS_CONFLICT"],
    [/(?:zone|domain)[\s\S]*(?:not active|pending|not found|could not find)|could not find[\s\S]*zone/,"DEPLOY_DOMAIN_NOT_READY"],
    [/authentication|not authorized|permission|unauthorized|\[code: 10000\]/,"DEPLOY_AUTH_FAILED"],
    [/script[\s\S]*(?:too large|size limit)|exceeds[\s\S]*size/,"DEPLOY_SIZE_LIMIT"],
    [/startup|validation|would exceed|cpu time/,"DEPLOY_WORKER_VALIDATION_FAILED"],
  ];
  const code=rules.find(([pattern])=>pattern.test(text))?.[1]||"DEPLOY_COMMAND_FAILED";
  const apiCode=text.match(/\[code:\s*(\d{1,6})\]/)?.[1];
  return apiCode?`${code} API_CODE_${apiCode}`:code;
}
