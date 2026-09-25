import test from 'node:test';
import assert from 'node:assert/strict';
import {assertNativeDenoIdentity, assertNativeHostIdentity} from './module_native_dependencies.mjs';
import path from 'node:path';

const edge=(name,pkg,kind=null)=>({name,pkg,dep_kinds:[{kind}]});
function fixture(){return {packages:[
 {id:'host',name:'TiangZ',version:'1'}, {id:'module',name:'game',version:'1'},
 {id:'core',name:'deno_core',version:'0.411.0'}, {id:'other-core',name:'deno_core',version:'0.410.0'},
 {id:'wrapper',name:'wrapper',version:'1'},
],resolve:{root:'host',nodes:[
 {id:'host',deps:[edge('deno_core','core'),edge('tiangz_module_0','module')]},
 {id:'module',deps:[edge('renamed_core','core')]},
 {id:'core',deps:[]},{id:'other-core',deps:[]},{id:'wrapper',deps:[edge('deno_core','other-core')]},
]}};}
const modules=[{id:'org.example.game'}];
test('same resolved crate identity works, including renamed dependencies',()=>{
 assert.doesNotThrow(()=>assertNativeDenoIdentity(fixture(),modules));
});
test('direct and transitive incompatible runtimes fail before compilation',()=>{
 for(const dependency of ['other-core','wrapper']){
  const data=fixture();data.resolve.nodes[1].deps=[edge('runtime',dependency)];
  assert.throws(()=>assertNativeDenoIdentity(data,modules),/Native dependency mismatch: org.example.game.*0.410.0.*host resolves 0.411.0/);
 }
});
test('same version from a different crate source is still a different Rust type',()=>{
 const data=fixture();data.packages[3].version='0.411.0';data.resolve.nodes[1].deps=[edge('deno_core','other-core')];
 assert.throws(()=>assertNativeDenoIdentity(data,modules),/Native dependency mismatch/);
});
test('uncompiled dev dependencies do not reject a valid extension',()=>{
 const data=fixture();data.resolve.nodes[1].deps.push(edge('test_runtime','other-core','dev'));
 assert.doesNotThrow(()=>assertNativeDenoIdentity(data,modules));
});
test('missing composition metadata cannot silently pass',()=>{
 const data=fixture();data.resolve.nodes=[];
 assert.throws(()=>assertNativeDenoIdentity(data,modules),/missing the host/);
});

test('Native transport must come from the selected host even when versions match', () => {
 const engine = path.resolve('fixture/current host');
 const data = fixture();
 data.packages[0].name = 'tiangz-module-host';
 data.packages.push({ id: 'transport', name: 'TiangZ', version: '1', manifest_path: path.join(engine, 'Cargo.toml') });
 data.resolve.nodes.push({ id: 'transport', deps: [] });
 data.resolve.nodes[1].deps.push(edge('tiangz_transport', 'transport'));
 assert.doesNotThrow(() => assertNativeHostIdentity(data, engine));
 data.packages.at(-1).manifest_path = path.resolve('fixture/previous host/Cargo.toml');
 assert.throws(() => assertNativeHostIdentity(data, engine), /Native host mismatch.*Explicitly align/);
 data.resolve.nodes[1].deps.at(-1).dep_kinds = [{ kind: 'dev' }];
 assert.doesNotThrow(() => assertNativeHostIdentity(data, engine));
 data.resolve.nodes[1].deps.at(-1).dep_kinds = [{ kind: null }];
 data.resolve.nodes.pop();
 assert.throws(() => assertNativeHostIdentity(data, engine), /Incomplete Native host/);
});
