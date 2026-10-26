import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';

/** Analyse les en-têtes HTTP effectivement reçus, jamais une balise ou une politique report-only. */
export function servedSecurityFailures(headers){
  const failures=[];
  const csp=headers.get('content-security-policy')||'';
  const policies=csp.split(',').map(policy=>{
    const directives=new Map();
    for(const part of policy.split(';').filter(Boolean)){
      const [name,...sources]=part.trim().split(/\s+/);
      if(!directives.has(name.toLowerCase()))directives.set(name.toLowerCase(),sources);
    }
    return directives;
  });
  const constrained=policies.some(policy=>{
    const ancestors=policy.get('frame-ancestors');
    return ancestors&&ancestors.length===1&&["'none'","'self'"].includes(ancestors[0]);
  });
  if(!constrained)failures.push('CSP_HTTP_FRAME_ANCESTORS_MISSING_OR_PERMISSIVE');
  if(!['DENY','SAMEORIGIN'].includes((headers.get('x-frame-options')||'').toUpperCase()))failures.push('X_FRAME_OPTIONS_MISSING_OR_PERMISSIVE');
  if((headers.get('x-content-type-options')||'').toLowerCase()!=='nosniff')failures.push('NOSNIFF_MISSING');
  if(!/max-age\s*=\s*[1-9][0-9]*/i.test(headers.get('strict-transport-security')||''))failures.push('HSTS_MISSING');
  return failures;
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  const url=new URL(process.argv[2]||'https://forsure.fans/feed');
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new Error('HTTPS_URL_WITHOUT_CREDENTIALS_REQUIRED');
  const response=await fetch(url,{method:'HEAD',redirect:'error',signal:AbortSignal.timeout(10_000)});
  const failures=servedSecurityFailures(response.headers);
  if(!response.ok)failures.unshift('HTTP_NOT_OK');
  console.log(JSON.stringify({origin:url.origin,path:url.pathname,status:response.status,passed:failures.length===0,failures}));
  if(failures.length)process.exitCode=1;
}
