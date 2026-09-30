import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { immutableCandidateFromOutput } from './build_result.mjs';
import { resolveModuleRuntimeBinary } from './module_runtime_binary.mjs';

// 独立临时工程与受控文件闸门，测试真实进程中活跃 worker 的热更和停机；不做性能测量。
// An isolated fixture and controlled file gate exercise live-worker hotfix and shutdown, not performance.
const root = path.resolve(import.meta.dirname, '..');
const env = {...process.env, RUST_LOG:'info', TIANGZ_SOAK_TOKEN:'local-hotfix-soak', TIANGZ_WATCHER_CONTROL:'stdin'};
function run(args) {
  const r = spawnSync(process.execPath,args,{cwd:root,env,encoding:'utf8',maxBuffer:32*1024*1024,windowsHide:true});
  assert.equal(r.status,0,r.stdout+r.stderr); return r.stdout;
}
const prepared = run(['tools/hotfix_load_soak.mjs','--prepare-only','1']);
const reportPath = /\[hotfix-load\] (.+report\.json)/.exec(prepared)?.[1]?.trim();
assert.ok(reportPath,prepared);
const fixture = JSON.parse(await readFile(reportPath,'utf8')).fixture;
const {project,probe,configPath} = fixture;
const moduleRoot=path.join(project,'modules/starter'), modules=path.join(project,'modules');
const gate=path.join(project,'worker-gate');
const manifestPath=path.join(moduleRoot,'tiangz.module.json');
const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
manifest.native={source:'native',crate:'rust',crateName:'lifecycle_worker',generatedRust:'rust/src/generated',generatedTypeScript:'src/model/generated/native',workers:[{name:'compute',capacity:2,maxInputBytes:1024,maxOutputBytes:64}]};
await writeFile(manifestPath,JSON.stringify(manifest));
await mkdir(path.join(moduleRoot,'native'),{recursive:true}); await mkdir(path.join(moduleRoot,'rust/src'),{recursive:true});
await writeFile(path.join(moduleRoot,'native/Worker.native'),'namespace fixture;\nabstract entity Entity { readonly id: u32; @transient readonly instanceId: u32; }\n');
await writeFile(path.join(moduleRoot,'rust/Cargo.toml'),'[package]\nname="lifecycle_worker"\nversion="0.1.0"\nedition="2024"\n[dependencies]\ndeno_core="0.411"\n');
await writeFile(path.join(moduleRoot,'rust/src/lib.rs'),'pub mod generated; pub mod native_data; pub use generated::{extension, BOOTSTRAP};\n');
await writeFile(path.join(moduleRoot,'rust/src/native_data.rs'),`pub fn worker_compute(input: String) -> Result<String,String> {
  let p=std::path::Path::new(&input); let deadline=std::time::Instant::now()+std::time::Duration::from_secs(10);
  std::fs::write(p.with_extension("started"),b"started").map_err(|e|e.to_string())?;
  while !p.exists() { if std::time::Instant::now()>deadline {return Err("test gate timeout".into())} std::thread::sleep(std::time::Duration::from_millis(5)); }
  std::fs::write(p.with_extension("done"),b"completed").map_err(|e|e.to_string())?; Ok("done".into())
}`);
const model=path.join(moduleRoot,'src/model/index.ts');
await writeFile(model,`import { NativeWorkers } from './generated/native/NativeWorkers';\nexport { NativeWorkers };\n`+(await readFile(model,'utf8')).replace('modelExports: {','modelExports: { NativeWorkers,'));
const handler=path.join(moduleRoot,'src/hotfix/counter/handlers/IncrementHandler.ts');
let source=(await readFile(handler,'utf8')).replace('import { CounterScene,','import { NativeWorkers, CounterScene,');
source=source.replace('    if (request.mode === 1)',`    if (request.mode === 20) { await NativeWorkers.compute.call(${JSON.stringify(gate)}); return {count:20}; }
    if (request.mode === 21) { await NativeWorkers.compute.call(${JSON.stringify(gate+'-stop')}); return {count:21}; }
    if (request.mode === 1)`);
await writeFile(handler,source);
run(['tools/game_project.mjs','build','--project',project]);
run(['tools/build_module_native.mjs','--modules-dir',modules]);
await writeFile(handler,source.replace('const codeVersion = 20;','const codeVersion = 30;'));
const candidate=immutableCandidateFromOutput(run(['tools/build_runtime_bundles.mjs','--modules-dir',modules,'--host-profile','modules','--out-dir',path.join(project,'dist'),'--hotfix-only']),'hotfix',path.join(project,'dist'));
const binary=await resolveModuleRuntimeBinary({engineRoot:root,modulesDirectory:modules});
const config=JSON.parse(await readFile(configPath,'utf8'));
const health=`http://127.0.0.1:${config.process.observability.health.port}`;
const child=spawn(binary,[`--runtime-root=${project}`,configPath],{cwd:project,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
let log=''; for(const s of [child.stdout,child.stderr])s.on('data',b=>{log+=b;});
const exited=new Promise(resolve=>child.once('exit',resolve)); let client;
async function until(fn,label) {for(let i=0;i<100;i++){if(await fn())return; await delay(25);}throw Error(label);}
async function exists(file){try{await access(file);return true}catch{return false}}
try {
  await until(async()=>{try{return(await fetch(health+'/ready')).ok}catch{return false}},'ready');
  const {connect}=await import(pathToFileURL(probe).href); client=await connect(config.scenes[0].port);
  const work=client.call(20); void work.catch(()=>{}); await until(()=>exists(gate+'.started'),'worker admitted');
  let applied=false;
  const reload=fetch(health+'/admin/hotfix/apply',{method:'POST',headers:{Authorization:'Bearer local-hotfix-soak','Content-Type':'application/json'},body:JSON.stringify({operationId:'native-worker-barrier',candidateDirectory:candidate})}).then(async r=>{const body=await r.text();assert.equal(r.status,200,body);applied=true;return JSON.parse(body)});
  void reload.catch(()=>{});
  await until(()=>log.includes('Hotfix ingress pause started'),'hotfix barrier entered');
  await delay(100); assert.equal(applied,false); assert.equal(await exists(gate+'.done'),false);
  await writeFile(gate,'release'); assert.equal((await work).count,20); const reloadResult=await reload;
  const stoppedWork=client.call(21).catch(()=>undefined); await until(()=>exists(gate+'-stop.started'),'stop worker admitted');
  child.stdin.end('shutdown\n'); await delay(100); assert.equal(child.exitCode,null);
  await writeFile(gate+'-stop','release'); assert.equal(await exited,0); await stoppedWork;
  await access(gate+'-stop.done');
  await writeFile(path.join(project,'native-worker-acceptance.json'),JSON.stringify({status:'passed',binary,candidate,reloadResult,hotfixBlockedWhileWorkerActive:true,shutdownDrainedAcceptedWorker:true},null,2));
  console.log(`native worker lifecycle passed: ${project}`);
} catch(error) { console.error(error); throw error; } finally {
  await writeFile(gate,'cleanup'); await writeFile(gate+'-stop','cleanup');
  client?.close(); if(child.exitCode===null){if(!child.stdin.writableEnded)child.stdin.end('shutdown\n');const timer=setTimeout(()=>child.kill(),11000);await exited;clearTimeout(timer);}
  await writeFile(path.join(project,'native-worker-runtime.log'),log);
}
