// @vitest-environment node
import {readFileSync} from 'node:fs';
import ts from 'typescript';
import {defineMcp,defineTool} from '@lovable.dev/mcp-js';
import {createMcpProtocolHandler} from '@lovable.dev/mcp-js/protocols/mcp';
import {z} from 'zod';
import {expect,it} from 'vitest';
it('preserves the Lovable wrapper protocol with the patched v1 SDK',async()=>{
  const mcp=defineMcp({name:'synthetic',title:'Synthetic compatibility check',version:'0.0.0',instructions:'',metrics:false,
    tools:[defineTool({name:'echo',title:'Echo',description:'Synthetic local echo',inputSchema:{text:z.string()},handler:async({text})=>({content:[{type:'text',text}]})})],
  });
  const handler=createMcpProtocolHandler(mcp);
  const send=async(method:string,params:unknown)=>{
    const response=await handler(new Request('https://local.invalid/mcp',{method:'POST',
      headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},
      body:JSON.stringify({jsonrpc:'2.0',id:1,method,params}),
    }));
    expect(response.status).toBe(200);
    const body=await response.text();
    return JSON.parse(body.startsWith('event:')?body.split('\n').find(line=>line.startsWith('data:'))!.slice(5):body);
  };
  expect((await send('tools/list',{})).result.tools.map((tool:{name:string})=>tool.name)).toEqual(['echo']);
  expect((await send('tools/call',{name:'echo',arguments:{text:'Local only'}})).result.content[0].text).toBe('Local only');
});
it('deploys the locally locked runtime without asking isolated Deno to resolve vulnerable transitive versions',()=>{
  const adapter=readFileSync('supabase/functions/mcp/index.ts','utf8');
  const runtime=readFileSync('supabase/functions/_shared/generated/mcp-handler.mjs','utf8');
  expect(adapter).toContain('../_shared/generated/mcp-handler.mjs');
  expect(adapter).not.toContain('npm:');
  expect(runtime).toContain('MCP SDK 1.32.1');
  const syntax=ts.createSourceFile('runtime.mjs',runtime,ts.ScriptTarget.ESNext,true,ts.ScriptKind.JS);
  const imports=syntax.statements.filter(ts.isImportDeclaration).map(item=>(item.moduleSpecifier as ts.StringLiteral).text);
  expect(imports.every(name=>name.startsWith('node:'))).toBe(true);
});
