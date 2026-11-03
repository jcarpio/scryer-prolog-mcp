#!/usr/bin/env node
// Adaptation of adamrybinski/prolog-mcp: same four tool names, native Scryer backend.
import {Server} from '@modelcontextprotocol/sdk/server/index.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {CallToolRequestSchema,ListToolsRequestSchema} from '@modelcontextprotocol/sdk/types.js';
import {Engine} from './engine.mjs';
const engine=new Engine();
const server=new Server({name:'scryer-prolog-mcp',version:'0.1.0'},{capabilities:{tools:{}}});
const schema=(properties,required)=>({type:'object',properties,required,additionalProperties:false});
const string={type:'string'};
server.setRequestHandler(ListToolsRequestSchema,async()=>({tools:[
 {name:'loadProgram',description:'Validate and REPLACE the stored Prolog source. Include :- use_module(library(clpz)). for integer constraints. Trusted local code only.',inputSchema:schema({program:string},['program'])},
 {name:'runPrologQuery',description:'Run one query in a fresh Scryer process. Returns first solution as Prolog text, including variable bindings. Use findall/3 for multiple ground solutions. Query mutations do not persist.',inputSchema:schema({query:string,template:string},['query'])},
 {name:'saveSession',description:'Save loaded source (not runtime mutations) under a simple session name.',inputSchema:schema({filename:string},['filename'])},
 {name:'loadSession',description:'Validate and replace current source from a saved session.',inputSchema:schema({filename:string},['filename'])}
]}));
server.setRequestHandler(CallToolRequestSchema,async({params:{name,arguments:a={}}})=>{
 try {
  let result;
  if(name==='loadProgram') result=await engine.loadProgram(a.program);
  else if(name==='runPrologQuery') {
   if(typeof a.query!=='string'||a.query.length>100000|| (a.template!==undefined && typeof a.template!=='string')) throw Error('Invalid query or template');
   result=await engine.query(a.query,a.template);
  } else if(name==='saveSession') result=await engine.saveSession(a.filename);
  else if(name==='loadSession') result=await engine.loadSession(a.filename);
  else throw Error('Unknown tool: '+name);
  return {content:[{type:'text',text:JSON.stringify(result)}],isError:['error','timeout','output_limit'].includes(result.status)};
 } catch(e) {return {isError:true,content:[{type:'text',text:String(e)}]};}
});
await server.connect(new StdioServerTransport());
