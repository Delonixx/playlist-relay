import test from 'node:test';
import assert from 'node:assert/strict';
import { PlaylistPruner, ruleCandidates, validatePruneSuggestions } from './prune.mjs';
import { MusicAI } from './ai.mjs';
import { createApp } from './server.mjs';
import { Netease } from './netease.mjs';
import { QQMusic } from './qq.mjs';

const tracks=n=>Array.from({length:n},(_,i)=>({id:String(i+1),name:`Track ${i+1} (Live)`,ar:[{name:'Artist'}],al:{name:'Concert'},songType:3}));
class Fixture {
  constructor(n=21){this.platform='netease';this.songs=tracks(n);this.writes=[];this.uid='u1';this.owner='u1';this.reads=0;}
  async user(){return {id:this.uid,name:'Fixture'};}
  async detail(){this.reads++;return {id:'90001',name:'Review',creator:{userId:this.owner},trackCount:this.songs.length,trackIds:this.songs.map(value=>({id:value.id})),tracks:structuredClone(this.songs)};}
  async readForPrune(){return this.detail();}
  async remove(pid,ids){this.writes.push([...ids]);this.songs=this.songs.filter(value=>!ids.includes(value.id));}
  async pause(){}
}
const rules={mode:'rules',rule:'live'};
async function prepared(api=new Fixture(),ai=new MusicAI({demo:true}),options=rules){const pruner=new PlaylistPruner(ai);await pruner.prepare(api,'90001',options);assert.equal(pruner.job.state,'preview');return {pruner,api,p:pruner.job.preview};}

test('explicit field filters use artist identity, Live and Remix markers, and keep uncertain editions unchecked',()=>{
  const songs=[{id:'1',title:'Song',artist:'keshi',album:'Album'},{id:'2',title:'Song',artist:'keshi',album:'Deluxe'},{id:'3',title:'Song (Live)',artist:'keshi / Friend',album:'Concert'},{id:'4',title:'Song',artist:'Otherkeshi',album:'Remix collection'}];
  assert.deepEqual(ruleCandidates(songs,{rule:'artist',value:'keshi'}).map(x=>x.id),['1','2','3']);
  assert.deepEqual(ruleCandidates(songs,{rule:'live'}).map(x=>x.id),['3']);
  assert.deepEqual(ruleCandidates(songs,{rule:'remix'}).map(x=>x.id),['4']);
  assert.deepEqual(ruleCandidates(songs,{rule:'editions'}).map(x=>[x.id,x.selected]),[['2',false]]);
  assert.throws(()=>ruleCandidates(songs,{rule:'artist',value:''}),/填写/);
  assert.equal(ruleCandidates([{id:'5',title:'Rock',artist:'AC/DC',album:'A'}],{rule:'artist',value:'AC/DC'}).length,1);
});
test('AI response must cover the current batch once, with reasons; unknown and low confidence cannot authorize deletion',()=>{
  const source=[{id:'1',ref:'p1'},{id:'2',ref:'p2'}],raw={tracks:[{ref:'p1',remove:true,known:true,confidence:'medium',reason:'具体理由'},{ref:'p2',remove:true,known:false,confidence:'high',reason:'不确定'}]};
  const valid=validatePruneSuggestions(raw,source);assert.equal(valid[0].eligible,true);assert.equal(valid[0].selected,false);assert.equal(valid[1].eligible,false);
  assert.throws(()=>validatePruneSuggestions({tracks:[raw.tracks[0]]},source),/覆盖/);
  assert.throws(()=>validatePruneSuggestions({tracks:[raw.tracks[0],{...raw.tracks[1],ref:'outside'}]},source),/批次外/);
  assert.throws(()=>validatePruneSuggestions({tracks:[raw.tracks[0],raw.tracks[0]]},source),/覆盖/);
  assert.throws(()=>validatePruneSuggestions({tracks:raw.tracks.map(x=>({...x,reason:''}))},source),/理由/);
});
test('preparation is read-only and checking 201 tracks never uses the old analysis sample limit',async()=>{
  const {api,pruner,p}=await prepared(new Fixture(201));assert.equal(p.total,201);assert.equal(p.candidates.length,201);assert.equal(pruner.plan.tracks.length,201);assert.equal(api.writes.length,0);
});
test('AI batches use only music metadata and request, never account ID, song ID, playlist link or key',async()=>{
  const api=new Fixture(67),ai=new MusicAI();ai.configure({key:'fixture-private-key'});const calls=[];
  ai.requestJSON=async(prompt,input)=>{calls.push(input);return {tracks:input.tracks.map(x=>({ref:x.ref,known:true,remove:true,confidence:'high',reason:'这首的编排特征符合要求'}))};};
  const {p}=await prepared(api,ai,{mode:'ai',request:'删掉编排薄的歌，保留有律动的歌'});
  assert.equal(calls.length,3);assert.equal(p.total,67);assert.equal(p.candidates.length,67);
  const body=JSON.stringify(calls);assert.doesNotMatch(body,/fixture-private-key|90001|u1|cookie|userId/);assert.ok(calls.every(x=>x.tracks.every(t=>Object.keys(t).sort().join(',')==='album,artist,ref,title')));
});
test('truncated AI output stops pruning with a relevant message and without any write',async()=>{
  const ai=new MusicAI({transport:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))});ai.configure({key:'fixture-key'});
  const api=new Fixture(2),pruner=new PlaylistPruner(ai);await pruner.prepare(api,'90001',{mode:'ai',request:'删掉编排薄的歌'});
  assert.equal(pruner.job.state,'error');assert.match(pruner.job.error,/未生成待删计划/);assert.equal(api.writes.length,0);assert.equal(pruner.plan,null);
});
test('incomplete playlists, unauthorized owners, and playlists over 1000 stop before AI and writes',async()=>{
  for(const kind of ['size','partial','owner']){
    const api=new Fixture(kind==='size'?1001:3);if(kind==='owner')api.owner='other';if(kind==='partial')api.readForPrune=async()=>({...await api.detail(),tracks:[]});
    const pruner=new PlaylistPruner(new MusicAI({demo:true}));await pruner.prepare(api,'90001',rules);assert.equal(pruner.job.state,'error');assert.equal(api.writes.length,0);
  }
});
test('confirmation, revision and exact preview membership are required; removing unchecked tracks is impossible',async()=>{
  const {api,pruner,p}=await prepared();
  await assert.rejects(pruner.execute(api,p.revision,['1'],false),/确认/);
  await assert.rejects(pruner.execute(api,'stale',['1'],true),/过期/);
  await assert.rejects(pruner.execute(api,p.revision,['999'],true),/候选/);
  await assert.rejects(pruner.execute(api,p.revision,['1','1'],true),/候选/);
  const result=await pruner.execute(api,p.revision,['2','4'],true);
  assert.deepEqual(api.writes,[['2','4']]);assert.deepEqual(result.verified,['2','4']);assert.ok(api.songs.some(x=>x.id==='1'));assert.equal(pruner.plan,null);
  await assert.rejects(pruner.execute(api,p.revision,['1'],true),/过期/);
});
test('playlist mutation, reorder and account change invalidate confirmation before any write',async()=>{
  for(const kind of ['extra','reorder','account']){
    const {api,pruner,p}=await prepared(new Fixture(3));if(kind==='extra')api.songs.push({...tracks(4)[3]});if(kind==='reorder')api.songs.reverse();if(kind==='account')api.uid='different';
    await assert.rejects(pruner.execute(api,p.revision,['1'],true),/变化/);assert.equal(api.writes.length,0);
  }
});
test('deletion batches never exceed 10 and reread exact retained IDs and order',async()=>{
  const {api,pruner,p}=await prepared(new Fixture(23));const result=await pruner.execute(api,p.revision,p.candidates.map(x=>x.id),true);
  assert.deepEqual(api.writes.map(x=>x.length),[10,10,3]);assert.equal(result.verified.length,23);assert.equal(result.stopped,'');assert.equal(api.songs.length,0);
});
test('timed out write with server-side success is read back once and never retried; later batches stay untouched',async()=>{
  const {api,pruner,p}=await prepared(new Fixture(12));const remove=api.remove.bind(api);api.remove=async(pid,ids)=>{await remove(pid,ids);throw new Error('模拟超时');};
  const result=await pruner.execute(api,p.revision,p.candidates.map(x=>x.id),true);
  assert.equal(api.writes.length,1);assert.equal(result.verified.length,10);assert.deepEqual(result.notAttempted,['11','12']);assert.match(result.stopped,/未重试/);
});
test('rejected, partial and unexpected collateral removals all stop later writes with an honest report',async()=>{
  for(const kind of ['reject','partial','collateral']){
    const {api,pruner,p}=await prepared(new Fixture(12));
    api.remove=async(_,ids)=>{api.writes.push(ids);if(kind==='reject')throw new Error('拒绝');api.songs=api.songs.filter(value=>!(kind==='partial'?ids.slice(0,2):[...ids,'12']).includes(value.id));};
    const result=await pruner.execute(api,p.revision,p.candidates.map(x=>x.id),true);assert.equal(api.writes.length,1);assert.ok(result.stopped);assert.equal(result.notAttempted.length,2);if(kind==='partial'){assert.equal(result.verified.length,2);assert.equal(result.remaining.length,8);}
  }
});
test('concurrent edit detected before second batch stops without dispatching it',async()=>{
  const {api,pruner,p}=await prepared(new Fixture(12));let reads=0;const detail=api.detail.bind(api);api.detail=async()=>{reads++;if(reads===3)api.songs.reverse();return detail();};
  const result=await pruner.execute(api,p.revision,p.candidates.map(x=>x.id),true);assert.equal(api.writes.length,1);assert.match(result.stopped,/变化/);assert.equal(result.notAttempted.length,2);
});
test('canceling an unfinished read discards late preview; cancellation during deletion is refused',async()=>{
  const api=new Fixture(3),pruner=new PlaylistPruner(new MusicAI({demo:true}));let resolve,entered;
  const ready=new Promise(r=>entered=r);api.readForPrune=()=>{entered();return new Promise(r=>resolve=r);};
  const task=pruner.prepare(api,'90001',rules);await ready;pruner.cancel();resolve(await api.detail());await task;assert.equal(pruner.job.state,'idle');assert.equal(pruner.plan,null);
  pruner.job={state:'checking'};assert.throws(()=>pruner.cancel(),/不能中断/);pruner.job={state:'removing'};assert.throws(()=>pruner.cancel(),/不能中断/);
});
test('Netease remove sends only del to the existing whitelisted endpoint and rejects nonmember ID',async()=>{
  const api=new Netease({wait:async()=>{}}),calls=[];api.verified=true;api.request=async(endpoint,data)=>{calls.push({endpoint,data});return {status:200,body:{code:200}};};
  const snapshot={id:'90001',trackIds:[{id:'1'}]};await api.remove('90001',['1'],snapshot);
  assert.deepEqual(calls,[{endpoint:'playlist/manipulate/tracks',data:{op:'del',pid:'90001',trackIds:'["1"]',imme:'true'}}]);await assert.rejects(api.remove('90001',['2'],snapshot),/完整歌单/);
});
test('Netease read-for-prune fetches all ID metadata in batches and rejects missing tracks or count mismatch',async()=>{
  const api=new Netease({wait:async()=>{}}),songs=tracks(205);api.detail=async()=>({id:'90001',name:'All',trackCount:205,trackIds:songs.map(x=>({id:x.id}))});
  const calls=[];api.request=async(_,data)=>{const ids=JSON.parse(data.c).map(x=>x.id);calls.push(ids);return {status:200,body:{code:200,songs:songs.filter(x=>ids.includes(x.id))}};};
  assert.equal((await api.readForPrune('90001')).tracks.length,205);assert.deepEqual(calls.map(x=>x.length),[100,100,5]);
  api.request=async()=>({status:200,body:{code:200,songs:[]}});await assert.rejects(api.readForPrune('90001'),/无法读取/);
});
test('QQ deletion uses snapshot song types independently from search cache; favorite directory and missing type are blocked',async()=>{
  const api=new QQMusic({wait:async()=>{}}),calls=[];api.credential={id:'7'};api.verified=true;api.directories.set('90001',5);api.songTypes.set('1',null);
  api.request=async(name,param)=>{calls.push({name,param});return {retCode:0};};
  const snapshot={id:'90001',dirId:5,creator:{userId:'7'},tracks:[{id:'1',songType:8}]};await api.remove('90001',['1'],snapshot);
  assert.deepEqual(calls,[{name:'remove',param:{dirId:5,tid:90001,bFmtUtf8:true,v_songInfo:[{songId:1,songType:8}]}}]);
  await assert.rejects(api.remove('90001',['1'],{...snapshot,dirId:201}),/普通/);await assert.rejects(api.remove('90001',['1'],{...snapshot,tracks:[{id:'1'}]}),/类型/);
});
test('server API separates preview and confirmation, binds revision to destination, exports metadata-only backup',async t=>{
  const adapter=new Fixture(3),app=createApp(adapter,{ai:new MusicAI({demo:true})});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  t.after(async()=>{app.server.closeAllConnections();await new Promise(r=>app.server.close(r));});
  const post=async(path,data={})=>{const res=await fetch(`http://127.0.0.1:${app.server.address().port}/api/${path}`,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token},body:JSON.stringify({expectedPlatform:'netease',...data})});return {status:res.status,body:await res.json()};};
  assert.equal((await post('prune/prepare',{target:'90001',...rules})).status,202);let result;
  for(let i=0;i<30;i++){result=(await post('prune/job')).body;if(result.state==='preview')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(result.state,'preview');assert.equal(adapter.writes.length,0);const revision=result.preview.revision;
  const backup=(await post('prune/backup',{revision})).body;assert.equal(backup.tracks.length,3);assert.doesNotMatch(JSON.stringify(backup),/u1|cookie|token/);
  assert.equal((await post('prune/execute',{revision,selections:['1']})).status,400);assert.equal((await post('prune/execute',{revision,selections:['1'],confirm:true})).status,202);
  for(let i=0;i<30;i++){result=(await post('prune/job')).body;if(result.state==='completed')break;await new Promise(r=>setTimeout(r,5));}
  assert.equal(result.state,'completed');assert.deepEqual(result.report.verified,['1']);assert.equal(adapter.songs.length,2);
});
