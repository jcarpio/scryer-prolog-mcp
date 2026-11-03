import {spawn} from 'node:child_process';
import {mkdtemp, writeFile, readFile, rm, mkdir} from 'node:fs/promises';
import {tmpdir, homedir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

export class Engine {
  constructor({binary=process.env.SCRYER_PROLOG || 'scryer-prolog', timeout=15000,
    sessions=process.env.SCRYER_SESSIONS || join(homedir(), '.scryer-prolog-sessions')}={}) {
    this.binary=binary; this.timeout=timeout; this.sessions=sessions; this.program='';
  }
  async run(program, query, template='true') {
    const dir=await mkdtemp(join(tmpdir(),'scryer-prolog-'));
    const token='mcp_'+randomUUID().replaceAll('-','');
    // Parse the query at runtime, after loading the user's operator declarations.
    const atom=s=>"'"+s.replaceAll('\\','\\\\').replaceAll("'","\\'")+"'";
    const text=query.trim().replace(/\.\s*$/,'');
    const source=`:- use_module(library(charsio)).\n${program}\n\n${token} :-\n catch((read_term_from_chars(${JSON.stringify('('+text+')-('+template+').')}, Pair, [variable_names(Names)]), Pair=(Goal-Template),\n (call(Goal) -> write(${atom(token+':success:')}), write_term(Names-Template,[quoted(true)]), nl ; write(${atom(token+':failure')}), nl)),\n E, (write(${atom(token+':error:')}), write_term(E,[quoted(true)]), nl)), halt.\n`;
    try {
      await writeFile(join(dir,'program.pl'),source);
      const output=await new Promise((resolve,reject)=>{
        const child=spawn(this.binary,['-f',join(dir,'program.pl'),'-g',token],{cwd:dir,stdio:['ignore','pipe','pipe']});
        let stdout='',stderr='',reason;
        const timer=setTimeout(()=>{reason='timeout'; child.kill('SIGKILL');},this.timeout);
        const append=(key,chunk)=>{
          if(key==='out') stdout+=chunk; else stderr+=chunk;
          if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)>1024*1024) {reason='output_limit'; child.kill('SIGKILL');}
        };
        child.stdout.on('data',c=>append('out',c)); child.stderr.on('data',c=>append('err',c));
        child.on('error',e=>{clearTimeout(timer);reject(e);});
        child.on('close',(code)=>{clearTimeout(timer);resolve({stdout,stderr,code,reason});});
      });
      if(output.reason) return {status:output.reason,...output};
      const marker=token+':'; const at=output.stdout.lastIndexOf(marker);
      if(at<0 || output.code!==0) return {status:'error',...output};
      const result=output.stdout.slice(at+marker.length).trim();
      return {status:result.startsWith('success:')?'success':result==='failure'?'failure':'error',
        result, stdout:output.stdout.slice(0,at),stderr:output.stderr};
    } finally {await rm(dir,{recursive:true,force:true});}
  }
  async loadProgram(program) {
    if(typeof program!=='string' || program.length>1000000) throw Error('Invalid program (maximum 1 MB)');
    const result=await this.run(program,'true');
    if(result.status==='success') this.program=program;
    return result;
  }
  query(query,template) {return this.run(this.program,query,template);}
  sessionPath(filename) {
    if(typeof filename!=='string'|| !/^[a-zA-Z0-9_-]{1,80}$/.test(filename)) throw Error('Use a session name containing letters, numbers, _ or -');
    return join(this.sessions,filename+'.pl');
  }
  async saveSession(filename) {
    const path=this.sessionPath(filename); await mkdir(this.sessions,{recursive:true,mode:0o700});
    await writeFile(path,this.program,{mode:0o600}); return {status:'saved',filename};
  }
  async loadSession(filename) {return this.loadProgram(await readFile(this.sessionPath(filename),'utf8'));}
}
