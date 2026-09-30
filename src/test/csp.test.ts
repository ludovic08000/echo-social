import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('allows cryptographic WASM without JavaScript eval or inline scripts', () => {
  const html = readFileSync('index.html', 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  expect(policy).toBeDefined();
  const directives = new Map(policy!.split(';').filter(Boolean).map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));
  expect(directives.get('script-src')).toEqual(["'self'", "'wasm-unsafe-eval'"]);
  expect(directives.get('script-src-elem')).toEqual(["'self'"]);
  expect(directives.get('object-src')).toEqual(["'none'"]);
});

it('allows camera and microphone capture only for the ForSure origin', () => {
  const html = readFileSync('index.html', 'utf8');
  const policy = html.match(/http-equiv="Permissions-Policy" content="([^"]+)"/)?.[1];

  expect(policy).toBeDefined();
  expect(policy).toContain('camera=(self)');
  expect(policy).toContain('microphone=(self)');
  expect(policy).toContain('geolocation=()');
  expect(policy).toContain('payment=()');
});

it('allows only the required GIPHY API and media origins', () => {
  const html = readFileSync('index.html', 'utf8');
  const policy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
  expect(policy).toBeDefined();
  const directives = new Map(policy!.split(';').filter(Boolean).map(part => {
    const [name, ...sources] = part.trim().split(/\s+/);
    return [name, sources];
  }));

  expect(directives.get('connect-src')).toContain('https://api.giphy.com');
  expect(directives.get('img-src')).toContain('https://*.giphy.com');
  expect(directives.get('connect-src')).not.toContain('https://*.giphy.com');
});
