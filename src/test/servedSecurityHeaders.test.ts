// @vitest-environment node
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
import {servedSecurityFailures} from '../../scripts/verify-served-security.mjs';
const base={'Strict-Transport-Security':'max-age=31536000','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY'};
it('accepts a real production HTTP policy blocking untrusted frames',()=>{
  expect(servedSecurityFailures(new Headers({...base,'Content-Security-Policy':"default-src 'self';frame-ancestors 'none'"}))).toEqual([]);
});
it('does not treat report-only, wildcard or absence of frame-ancestors as enforced protection',()=>{
  for(const additional of [{'Content-Security-Policy-Report-Only':"frame-ancestors 'none'"},{'Content-Security-Policy':"frame-ancestors *"},{'Content-Security-Policy':"default-src 'self'"},{'Content-Security-Policy':"frame-ancestors *;frame-ancestors 'none'"}]){
    expect(servedSecurityFailures(new Headers({...base,...additional}))).toContain('CSP_HTTP_FRAME_ANCESTORS_MISSING_OR_PERMISSIVE');
  }
});
it('requires real legacy anti-framing and transport headers too',()=>{
  expect(servedSecurityFailures(new Headers({'Content-Security-Policy':"frame-ancestors 'self'"})))
    .toEqual(['X_FRAME_OPTIONS_MISSING_OR_PERMISSIVE','NOSNIFF_MISSING','HSTS_MISSING']);
});

it('applies the enforced anti-frame headers to every Vercel route',()=>{
  const config=JSON.parse(readFileSync('vercel.json','utf8'));
  const global=config.headers.find((rule:{source:string})=>rule.source==='/(.*)');
  expect(global).toBeDefined();
  const headers=new Headers(global.headers.map(({key,value}:{key:string;value:string})=>[key,value]));
  expect(servedSecurityFailures(headers)).toEqual([]);
});
