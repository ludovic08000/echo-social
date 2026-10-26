// @vitest-environment node
import {readFileSync} from 'node:fs';
import {expect,it} from 'vitest';
const manifest=JSON.parse(readFileSync('package.json','utf8'));
const lock=JSON.parse(readFileSync('package-lock.json','utf8'));
it('locks all four native Capacitor packages to the same patched version',()=>{
  for(const name of ['core','cli','ios','android']){
    expect(manifest.dependencies['@capacitor/'+name]).toBe('8.5.3');
    expect(lock.packages['node_modules/@capacitor/'+name].version).toBe('8.5.3');
  }
});
it('preserves the previously validated PDF/router/tar/lodash versions during compatible updates',()=>{
  const patched:Record<string,string>={'@modelcontextprotocol/sdk':'1.32.1','pdfjs-dist':'6.4.299','react-router':'6.30.6','react-router-dom':'6.30.6',tar:'7.5.22',lodash:'4.18.1'};
  for(const [name,version] of Object.entries(patched)){
    const entries=Object.entries(lock.packages).filter(([path])=>path==='node_modules/'+name||path.endsWith('/node_modules/'+name));
    expect(entries.length).toBeGreaterThan(0);
    for(const [,entry] of entries)expect((entry as {version:string}).version).toBe(version);
  }
});
it('patches the critical proxy address dependency in every installed branch',()=>{
  const entries=Object.entries(lock.packages).filter(([path])=>path.endsWith('node_modules/proxy-addr'));
  expect(entries.length).toBeGreaterThan(0);
  for(const [,entry] of entries)expect((entry as {version:string}).version).toBe('2.0.8');
});
it('uses the fixed validator and a test runner without the vulnerable worker dependency',()=>{
  expect(manifest.dependencies.zod).toBe('4.6.7');
  expect(manifest.devDependencies.vitest).toBe('4.1.12');
  const validators=Object.entries(lock.packages).filter(([path])=>path.endsWith('node_modules/zod'));
  expect(validators.length).toBeGreaterThan(0);
  for(const [,entry] of validators)expect((entry as {version:string}).version).toBe('4.6.7');
  expect(Object.keys(lock.packages).some(path=>path.endsWith('node_modules/tinypool'))).toBe(false);
});
it('patches the glob 10 CLI without replacing the separate glob 11 branch',()=>{
  const versions=Object.entries(lock.packages).filter(([path])=>path.endsWith('node_modules/glob'))
    .map(([,entry])=>(entry as {version:string}).version);
  expect(versions).toContain('10.5.0');
  expect(versions.every(version=>!version.startsWith('10.')||version==='10.5.0')).toBe(true);
});
it('contains the native proxy navigation guards from the fixed vendor packages',()=>{
  const android=readFileSync('node_modules/@capacitor/android/capacitor/src/main/java/com/getcapacitor/Bridge.java','utf8');
  const ios=readFileSync('node_modules/@capacitor/ios/Capacitor/Capacitor/WebViewDelegationHandler.swift','utf8');
  expect(android).toContain('path.startsWith(CAPACITOR_HTTP_INTERCEPTOR_START)');
  expect(ios).toContain('navURL.path.starts(with: CapacitorBridge.httpInterceptorStartIdentifier)');
  expect(ios).toContain('decisionHandler(.cancel)');
});
