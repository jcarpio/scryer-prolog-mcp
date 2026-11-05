import assert from 'node:assert/strict';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';

const client = new Client(
  {name: 'smoke', version: '1'},
  {capabilities: {}}
);

await client.connect(new StdioClientTransport({
  command: process.execPath,
  args: ['index.mjs'],
  env: {...process.env}
}));

function successful(response) {
  assert.equal(response.isError, false);
  const data = JSON.parse(response.content[0].text);
  assert.equal(data.status, 'success');
  return data;
}

try {
  const {tools} = await client.listTools();
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    [
      'loadProgram',
      'runPrologQuery',
      'runProgramQuery',
      'saveSession',
      'loadSession'
    ].sort()
  );

  successful(await client.callTool({
    name: 'loadProgram',
    arguments: {
      program: ':- use_module(library(clpz)).\nstored_program(original).'
    }
  }));

  let data = successful(await client.callTool({
    name: 'runPrologQuery',
    arguments: {
      query: 'X in 1..3, X #> 1, labeling([], [X])',
      template: 'X'
    }
  }));
  assert.equal(data.result, "success:['X'=2]-2");

  data = successful(await client.callTool({
    name: 'runProgramQuery',
    arguments: {
      program: 'dify_test(ready).',
      query: 'dify_test(X).',
      template: 'X'
    }
  }));
  assert.match(data.result, /ready/);

  data = successful(await client.callTool({
    name: 'runPrologQuery',
    arguments: {
      query: 'stored_program(X).',
      template: 'X'
    }
  }));
  assert.match(data.result, /original/);

  console.log('PASS: MCP tools, CLP(Z), program+query, stored program isolation');
} finally {
  await client.close();
}
