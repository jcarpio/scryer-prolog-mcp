import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
const client=new Client({name:'smoke',version:'1'},{capabilities:{}});
await client.connect(new StdioClientTransport({command:process.execPath,args:['index.mjs'],env:{...process.env}}));
try {
 assert.equal((await client.listTools()).tools.length,4);
 let r=await client.callTool({name:'loadProgram',arguments:{program:':- use_module(library(clpz)).'}});
 assert.equal(r.isError,false);
 r=await client.callTool({name:'runPrologQuery',arguments:{query:'X in 1..3, X #> 1, labeling([], [X])'}});
 assert.equal(r.isError,false); assert.match(r.content[0].text,/success/);
 console.log('PASS: MCP stdio initialize, listTools, loadProgram, CLP(Z) query');
} finally {await client.close();}
