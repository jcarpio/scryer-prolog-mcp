import assert from 'node:assert/strict';
import {Engine} from './engine.mjs';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=await mkdtemp(join(tmpdir(),'scryer-test-'));
const e=new Engine({sessions:dir,timeout:2000});
try {
 assert.equal((await e.loadProgram(':- use_module(library(clpz)).\nsmall(X,Y) :- X in 1..3, Y in 1..3, X #< Y, labeling([], [X,Y]).')).status,'success');
 const r=await e.query('findall([X,Y], small(X,Y), Solutions)','Solutions');
 assert.equal(r.status,'success'); assert.match(r.result,/\[\[1,2\],\[1,3\],\[2,3\]\]/);
 assert.equal((await e.query('fail')).status,'failure');
 assert.equal((await e.query('throw(test_error)')).status,'error');
 assert.equal((await e.query('not_a_predicate')).status,'error');
 await e.saveSession('demo'); await e.loadProgram('other.'); await e.loadSession('demo');
 assert.equal((await e.query('small(1,2)')).status,'success');
 assert.throws(()=>e.sessionPath('../bad'));
 await e.loadProgram('loop :- loop.');
 assert.equal((await e.query('loop')).status,'timeout');
 console.log('PASS: CLP(Z), bindings, failure, exceptions, sessions, path validation, timeout');
} finally {await rm(dir,{recursive:true,force:true});}
