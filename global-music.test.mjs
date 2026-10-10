import test from 'node:test';
import assert from 'node:assert/strict';
import { Spotify, AppleMusic } from './global-music.mjs';
import { createApp } from './server.mjs';
import { rank, playlistId, appendVerified, coverUrl } from './core.mjs';
import { Demo } from './demo.mjs';
import { signAppleToken,appleTokenFromEnvironment } from './apple-token.mjs';
import { generateKeyPairSync,verify } from 'node:crypto';

const PID='A'.repeat(22), S1='B'.repeat(22), S2='C'.repeat(22), CLIENT='a'.repeat(32);
const SCOPES='playlist-read-private playlist-modify-private playlist-modify-public';
const json=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'Content-Type':'application/json'}});
const jwt=()=>[Buffer.from(JSON.stringify({alg:'ES256',kid:'TESTKEY123'})).toString('base64url'),Buffer.from(JSON.stringify({iss:'TESTTEAM12',iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600})).toString('base64url'),'c2ln'].join('.');
async function spotifyFixture({owner='test-user',partial=false}={}){
  const calls=[],ids=[S1];
  const adapter=new Spotify({fetch:async(url,options)=>{
    const u=new URL(url);calls.push({url,options});
    if(u.hostname==='accounts.spotify.com')return json({access_token:'fake-access',refresh_token:'fake-refresh',expires_in:3600,scope:SCOPES});
    if(u.pathname==='/v1/me')return json({id:'test-user',display_name:'Test User'});
    if(u.pathname==='/v1/me/playlists'&&options.method==='POST')return json({id:PID,name:'New'});
    if(u.pathname==='/v1/me/playlists')return json({items:[{id:PID,name:'Owned',owner:{id:owner},items:{total:ids.length}},{id:S2,name:'Other',owner:{id:'other'}}],next:null});
    if(u.pathname==='/v1/search')return json({tracks:{items:[{id:S2,name:'So Sick',type:'track',artists:[{name:'Ne-Yo'}],album:{name:'Album',images:[{url:'https://i.scdn.co/image/test'}]},duration_ms:200000}]}});
    if(u.pathname===`/v1/playlists/${PID}`)return json({id:PID,name:'Owned',owner:{id:owner}});
    if(u.pathname===`/v1/playlists/${PID}/items`&&options.method==='POST'){const body=JSON.parse(options.body);if(!partial)ids.push(...body.uris.map(s=>s.split(':').at(-1)));return json({snapshot_id:'snapshot'});}
    if(u.pathname===`/v1/playlists/${PID}/items`)return json({items:ids.map(id=>({item:{id,type:'track',name:'Song',artists:[],album:{}}})),next:null});
    throw new Error('Unexpected mock route');
  }});adapter.pause=async()=>{};adapter.configure({clientId:CLIENT});
  const auth=adapter.beginAuth('http://127.0.0.1:8765/oauth/spotify/callback');
  await adapter.finishAuth({state:new URL(auth.authorizeUrl).searchParams.get('state'),code:'test-code'});
  return {adapter,calls,ids};
}
async function appleFixture({editable=true,unmapped=false,missingAfterWrite=false}={}){
  const calls=[],ids=['100'],token=jwt();
  const adapter=new AppleMusic({fetch:async(url,options)=>{
    const u=new URL(url);calls.push({url,options});
    if(u.pathname==='/v1/me/storefront')return json({data:[{id:'cn'}]});
    if(u.pathname==='/v1/me/library/playlists')return json({data:[{id:'p.test',attributes:{name:'Owned',canEdit:editable}},{id:'p.other',attributes:{name:'Other',canEdit:false}}]});
    if(u.pathname==='/v1/me/library/playlists/p.test')return json({data:[{id:'p.test',attributes:{name:'Owned',canEdit:editable}}]});
    if(u.pathname==='/v1/me/library/playlists/p.test/tracks'&&options.method==='POST'){const body=JSON.parse(options.body);if(!missingAfterWrite)ids.push(...body.data.map(s=>s.id));return new Response(null,{status:204});}
    if(u.pathname==='/v1/me/library/playlists/p.test/tracks')return json({data:ids.map(id=>({id:'i.song'+id,type:'library-songs',attributes:{name:'Song',artistName:'Artist'}}))});
    if(u.pathname.startsWith('/v1/me/library/songs/'))return json({data:[{relationships:{catalog:{data:unmapped?[]:[{id:u.pathname.match(/song(\d+)/)?.[1],type:'songs'}]}}}]});
    if(u.pathname==='/v1/catalog/cn/search')return json({results:{songs:{data:[{id:'101',attributes:{name:'So Sick',artistName:'Ne-Yo',albumName:'Album',url:'https://music.apple.com/cn/song/101',artwork:{url:'https://is1-ssl.mzstatic.com/image/{w}x{h}.jpg'}}}]}}});
    throw new Error('Unexpected mock route');
  }});adapter.pause=async()=>{};adapter.configure({developerToken:token,storefront:'us'});const auth=adapter.beginAuth();await adapter.finishAuth(auth.nonce,'fake-apple-user-token');return {adapter,calls,ids,token};
}

test('global identifiers, recording matches, image domains and external attribution remain restricted',()=>{
  assert.equal(playlistId('spotify:playlist:'+PID,'spotify'),PID);
  assert.equal(playlistId('https://open.spotify.com/playlist/'+PID+'?si=x','spotify'),PID);
  assert.throws(()=>playlistId('https://open.spotify.com.evil.test/playlist/'+PID,'spotify'));
  assert.throws(()=>playlistId('123','spotify'));
  assert.equal(playlistId('p.test','apple'),'p.test');assert.throws(()=>playlistId('https://music.apple.com/us/playlist/x/pl.test','apple'));
  const rows=rank({title:'Song',artist:'Artist'},[{id:S1,platform:'spotify',name:'Song',ar:[{name:'Artist'}],externalUrl:'https://open.spotify.com/track/'+S1},{id:'123',platform:'spotify',name:'Song'},{id:S2,platform:'spotify',name:'Song (Live)',ar:[{name:'Artist'}]}]);
  assert.equal(rows.selected,S1);assert.equal(rows.candidates.length,2);assert.equal(rows.candidates[0].platform,'spotify');
  assert.equal(coverUrl('https://i.scdn.co/image/test'),'https://i.scdn.co/image/test');assert.equal(coverUrl('https://i.scdn.co.evil.test/image/test'),'');assert.equal(coverUrl('https://is1-ssl.mzstatic.com/a.jpg'),'https://is1-ssl.mzstatic.com/a.jpg');assert.equal(coverUrl('https://is1-ssl.mzstatic.com:444/a.jpg'),'');
});
test('Spotify PKCE has exact loopback redirect, no secret, one-use state and no credential disclosure',async()=>{
  const {adapter,calls}=await spotifyFixture();assert.equal((await adapter.user()).id,'test-user');
  const auth=adapter.beginAuth('http://127.0.0.1:8765/oauth/spotify/callback'),u=new URL(auth.authorizeUrl);
  assert.equal(u.searchParams.get('code_challenge_method'),'S256');assert.equal(u.searchParams.get('code_challenge').length,43);
  await assert.rejects(adapter.finishAuth({state:'f'.repeat(64),code:'wrong'}),/校验/);assert.ok(adapter.pending);
  const state=u.searchParams.get('state');await adapter.finishAuth({state,code:'test-code'});await assert.rejects(adapter.finishAuth({state,code:'again'}),/校验/);
  assert.doesNotMatch(JSON.stringify(adapter.sessionInfo()),/fake-access|fake-refresh|test-code/);
  const payload=new URLSearchParams(calls.find(c=>c.url.endsWith('/api/token')).options.body);assert.ok(payload.get('code_verifier'));assert.equal(payload.get('client_secret'),null);
  assert.throws(()=>adapter.beginAuth('http://localhost:8765/oauth/spotify/callback'),/回调/);
});
test('Spotify owned playlists append only, skip existing IDs and verify new items response',async()=>{
  const {adapter,calls}=await spotifyFixture();assert.equal((await adapter.playlists()).length,1);const row=rank({title:'So Sick',artist:'Ne-Yo'},await adapter.search({title:'So Sick',artist:'Ne-Yo'}));assert.equal(row.selected,S2);
  const result=await appendVerified(adapter,PID,'test-user',[S1,S2]);assert.deepEqual(result.skipped,[S1]);assert.deepEqual(result.verified,[S2]);assert.equal(result.stopped,'');
  const writes=calls.filter(c=>c.options.method==='POST'&&c.url.includes('/items'));assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{uris:['spotify:track:'+S2]});
});
test('Spotify foreign owner and partial writes stop without retry',async()=>{
  const foreign=await spotifyFixture({owner:'other'});await assert.rejects(appendVerified(foreign.adapter,PID,'test-user',[S2]),/自己/);assert.equal(foreign.calls.filter(c=>c.options.method==='POST'&&c.url.includes('/items')).length,0);
  const partial=await spotifyFixture({partial:true});const result=await appendVerified(partial.adapter,PID,'test-user',[S2]);assert.deepEqual(result.unverified,[S2]);assert.equal(partial.calls.filter(c=>c.options.method==='POST'&&c.url.includes('/items')).length,1);
});
test('Spotify private creation uses current endpoint, and expired access refreshes once before dispatch',async()=>{
  const {adapter,calls}=await spotifyFixture();const created=await adapter.create('New');assert.equal(created.id,PID);
  const create=calls.find(x=>new URL(x.url).pathname==='/v1/me/playlists'&&x.options.method==='POST');assert.deepEqual(JSON.parse(create.options.body),{name:'New',public:false});
  const before=calls.filter(x=>x.url.endsWith('/api/token')).length;adapter.tokens.expires=0;
  await Promise.all([adapter.user(),adapter.user()]);assert.equal(calls.filter(x=>x.url.endsWith('/api/token')).length,before+1);
  await assert.rejects(adapter.create('New','guessed'),/可见性/);
});
test('failed Spotify token or missing granted scopes never creates a session',async()=>{
  for(const result of [{access_token:'fake-access',expires_in:3600,scope:'playlist-read-private'},{access_token:'fake-access',expires_in:0,scope:SCOPES}]){
    const adapter=new Spotify({fetch:async()=>json(result)});adapter.configure({clientId:CLIENT});const auth=adapter.beginAuth('http://127.0.0.1:8765/oauth/spotify/callback');await assert.rejects(adapter.finishAuth({state:new URL(auth.authorizeUrl).searchParams.get('state'),code:'test-code'}));assert.equal(adapter.sessionInfo().hasSession,false);
  }
});
test('Spotify rate failures and untrusted pagination never retry or send a token offsite',async()=>{
  const {adapter}=await spotifyFixture();let requests=0;adapter.fetcher=async()=>{requests++;return json({error:{reason:'QUOTA_EXCEEDED',message:'fake-access'}},429);};await assert.rejects(adapter.search({title:'x'}),/429/);assert.equal(requests,1);
  adapter.fetcher=async()=>{requests++;return json({items:[],next:'https://evil.test/steal'});};await assert.rejects(adapter.pages('/v1/me/playlists'),/官方接口/);assert.equal(requests,2);
});
test('late canceled Spotify exchange cannot restore a cleared account',async()=>{
  let release;const transport=new Promise(r=>release=r);const adapter=new Spotify({fetch:async()=>{await transport;return json({access_token:'fake-access',expires_in:3600,scope:SCOPES});}});adapter.configure({clientId:CLIENT});const auth=adapter.beginAuth('http://127.0.0.1:8765/oauth/spotify/callback');const pending=adapter.finishAuth({state:new URL(auth.authorizeUrl).searchParams.get('state'),code:'test-code'});adapter.clear();release();await assert.rejects(pending,/取消/);assert.equal(adapter.sessionInfo().hasSession,false);
});
test('Apple verifies user storefront, maps library IDs to catalog IDs and deduplicates readback',async()=>{
  const {adapter,calls}=await appleFixture();assert.equal(adapter.storefront,'cn');assert.equal((await adapter.playlists()).length,1);const song=(await adapter.search({title:'So Sick',artist:'Ne-Yo'}))[0];assert.equal(song.al.picUrl,'https://is1-ssl.mzstatic.com/image/300x300.jpg');
  const result=await appendVerified(adapter,'p.test','apple-library',['100','101']);assert.deepEqual(result.skipped,['100']);assert.deepEqual(result.verified,['101']);assert.equal(result.stopped,'');
  const writes=calls.filter(c=>c.options.method==='POST'&&c.url.includes('/tracks'));assert.equal(writes.length,1);assert.deepEqual(JSON.parse(writes[0].options.body),{data:[{id:'101',type:'songs'}]});assert.doesNotMatch(JSON.stringify(adapter.sessionInfo()),/fake-apple-user-token/);
});
test('Apple non-editable, unmappable songs and missing readback cannot authorize or claim a write',async()=>{
  const readonly=await appleFixture({editable:false});await assert.rejects(appendVerified(readonly.adapter,'p.test','apple-library',['101']),/可编辑/);assert.equal(readonly.calls.filter(c=>c.options.method==='POST').length,0);
  const local=await appleFixture({unmapped:true});await assert.rejects(appendVerified(local.adapter,'p.test','apple-library',['101']),/本地歌曲/);assert.equal(local.calls.filter(c=>c.options.method==='POST').length,0);
  const missing=await appleFixture({missingAfterWrite:true});const result=await appendVerified(missing.adapter,'p.test','apple-library',['101']);assert.deepEqual(result.unverified,['101']);assert.equal(missing.calls.filter(c=>c.options.method==='POST').length,1);
});
test('Apple delayed library visibility polls reads with bounded backoff and never repeats the write',async()=>{
  const {adapter,calls}=await appleFixture(),realFetch=adapter.fetcher,delays=[];
  let afterWrite=false,reads=0;
  adapter.pause=async(ms=1200)=>{delays.push(ms);};
  adapter.fetcher=async(url,options)=>{
    if(options.method==='POST'){afterWrite=true;return realFetch(url,options);}
    if(afterWrite&&new URL(url).pathname==='/v1/me/library/playlists/p.test/tracks'&&++reads<3)return json({data:[{id:'i.song100',type:'library-songs',attributes:{name:'Song',playParams:{catalogId:'100'}}}]});
    return realFetch(url,options);
  };
  const report=await appendVerified(adapter,'p.test','apple-library',['101']);
  assert.deepEqual(report.verified,['101']);assert.equal(report.stopped,'');assert.equal(reads,3);
  assert.equal(calls.filter(c=>c.options.method==='POST').length,1);
  assert.ok(delays.includes(2400));assert.ok(delays.includes(4800));
});
test('Apple rejects private keys, expired JWT and replay; clearing removes all app credentials',async()=>{
  const {adapter,token}=await appleFixture();assert.throws(()=>adapter.configure({developerToken:'-----BEGIN PRIVATE KEY-----'}),/私钥/);assert.equal(adapter.sessionInfo().hasSession,true);
  const auth=adapter.beginAuth();assert.equal(adapter.authConfig(auth.nonce).developerToken,token);await assert.rejects(adapter.finishAuth('wrong','fake-user-token'),/过期/);await adapter.finishAuth(auth.nonce,'fake-user-token');await assert.rejects(adapter.finishAuth(auth.nonce,'fake-user-token'),/过期/);
  assert.equal(adapter.capabilities().create,false);await assert.rejects(adapter.create('x'),/首版/);adapter.clear();assert.equal(adapter.sessionInfo().hasSession,false);assert.equal(adapter.sessionInfo().configured,false);assert.equal(adapter.developerToken,'');
});
test('late canceled Apple verification cannot restore credentials',async()=>{
  let release;const adapter=new AppleMusic({fetch:async()=>{await new Promise(r=>release=r);return json({data:[{id:'us'}]});}});adapter.configure({developerToken:jwt()});const auth=adapter.beginAuth();const pending=adapter.finishAuth(auth.nonce,'fake-user-token');await Promise.resolve();adapter.clear();release();await assert.rejects(pending,/取消/);assert.equal(adapter.sessionInfo().hasSession,false);
});
test('local Apple signing uses ES256 P1363, one-hour expiry and exact loopback origin without exposing private keys',async()=>{
  const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'}),origin='http://127.0.0.1:8765';
  const token=signAppleToken({privateKey:privateKey.export({type:'pkcs8',format:'pem'}),teamId:'TESTTEAM12',keyId:'TESTKEY123',origin}),[header,payload,signature]=token.split('.');
  assert.equal(verify('sha256',Buffer.from(header+'.'+payload),{key:publicKey,dsaEncoding:'ieee-p1363'},Buffer.from(signature,'base64url')),true);
  const data=JSON.parse(Buffer.from(payload,'base64url'));assert.equal(data.exp-data.iat,3600);assert.deepEqual(data.origin,[origin]);
  const calls=[],adapter=new AppleMusic({fetch:async(url,options)=>{calls.push(options);return json({data:[{id:'us'}]});}});
  assert.throws(()=>adapter.configure({developerToken:token,origin:'http://127.0.0.1:9999'}),/origin/);
  adapter.configure({developerToken:token,origin});const auth=adapter.beginAuth();await adapter.finishAuth(auth.nonce,'fake-user-token');await adapter.verifySession();assert.ok(calls.every(c=>c.headers.Origin===origin));
  adapter.developerExpires=0;await assert.rejects(adapter.verifySession(),/已过期/);
  const expired=signAppleToken({privateKey:privateKey.export({type:'pkcs8',format:'pem'}),teamId:'TESTTEAM12',keyId:'TESTKEY123',origin,now:Math.floor(Date.now()/1000)-7200});assert.throws(()=>adapter.configure({developerToken:expired,origin}),/有效期/);
  assert.equal(await appleTokenFromEnvironment({},origin),'');assert.equal(await appleTokenFromEnvironment({APPLE_MUSIC_DEVELOPER_TOKEN:'already-signed'},origin),'already-signed');
  await assert.rejects(appleTokenFromEnvironment({APPLE_MUSIC_KEY_FILE:'relative.p8'},origin),/绝对路径/);
});
test('server permits only state-checked Spotify callback, keeps main CSP local and blocks AI content ingestion',async(t)=>{
  const {adapter}=await spotifyFixture(),app=createApp(new Demo(),{adapters:{netease:new Demo(),spotify:adapter}});await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base='http://127.0.0.1:'+app.server.address().port;
  const post=(path,data={})=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token},body:JSON.stringify(data)});
  await post('platform',{platform:'spotify'});const started=await(await post('oauth/start')).json(),state=new URL(started.authorizeUrl).searchParams.get('state');
  const bad=await fetch(base+'/oauth/spotify/callback?state=bad&code=do-not-echo',{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(bad.status,400);const badText=await bad.text();assert.doesNotMatch(badText,/do-not-echo/);assert.ok(!badText.includes(app.token));assert.ok(adapter.pending);
  const valid=await fetch(base+'/oauth/spotify/callback?'+new URLSearchParams({state,code:'test-code'}),{headers:{'Sec-Fetch-Site':'cross-site'}});assert.equal(valid.status,200);assert.ok(!(await valid.text()).includes(app.token));
  const replay=await fetch(base+'/oauth/spotify/callback?'+new URLSearchParams({state,code:'test-code'}));assert.equal(replay.status,400);
  assert.equal((await post('ai/analyze',{text:'So Sick — Ne-Yo'})).status,400);assert.equal((await post('ai/recommend',{})).status,400);
  const page=await fetch(base);assert.doesNotMatch(page.headers.get('Content-Security-Policy'),/js-cdn/);const authPage=await fetch(base+'/apple-auth.html');assert.match(authPage.headers.get('Content-Security-Policy'),/js-cdn\.music\.apple\.com/);
  await post('platform',{platform:'netease'});assert.equal((await post('ai/analyze',{tracks:[{title:'x',artist:'y',sourcePlatform:'spotify'}]})).status,400);
});
test('Apple authorization config requires local token, pending nonce and active provider',async(t)=>{
  const {adapter}=await appleFixture(),app=createApp(adapter);await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base='http://127.0.0.1:'+app.server.address().port;
  const post=(path,data={},token=app.token)=>fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':token},body:JSON.stringify(data)});
  const auth=await(await post('oauth/start')).json(),nonce=new URL(auth.authorizeUrl).hash.split(':')[1];assert.ok(nonce);
  assert.equal((await post('apple/auth-config',{nonce},'invalid')).status,403);assert.equal((await post('apple/auth-config',{nonce:'bad'})).status,400);assert.equal((await post('apple/auth-config',{nonce})).status,200);
  const valid=await post('apple/user-token',{nonce,userToken:'fake-token'});assert.equal(valid.status,200);assert.equal((await post('apple/auth-config',{nonce})).status,400);assert.equal((await post('create',{confirm:true,name:'x',privacy:'10'})).status,400);
});
test('both global adapters complete server search, revision-confirmed import and verified report without repeating writes',async t=>{
  for(const platform of ['spotify','apple']){
    const fixture=platform==='spotify'?await spotifyFixture():await appleFixture(),{adapter,calls}=fixture,app=createApp(adapter),pid=platform==='spotify'?PID:'p.test',expectedId=platform==='spotify'?S2:'101';
    await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());const base='http://127.0.0.1:'+app.server.address().port;
    const post=async(path,data={})=>{const response=await fetch(base+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token},body:JSON.stringify({expectedPlatform:platform,...data})});return {response,value:await response.json()};};
    const match=await post('match',{text:'So Sick — Ne-Yo',target:pid});assert.equal(match.response.status,202);
    let job;for(let attempt=0;attempt<50;attempt++){job=(await post('job')).value;if(job.state==='matched')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(job.state,'matched');assert.equal(job.rows[0].selected,expectedId);
    assert.equal((await post('import',{confirm:true,target:pid,revision:'stale',selections:[expectedId]})).response.status,400);
    const imported=await post('import',{confirm:true,target:pid,revision:job.revision,selections:[expectedId]});assert.equal(imported.response.status,202);
    for(let attempt=0;attempt<50;attempt++){job=(await post('job')).value;if(job.state==='imported')break;await new Promise(r=>setTimeout(r,10));}
    assert.equal(job.state,'imported');assert.deepEqual(job.report.verified,[expectedId]);assert.equal(job.report.stopped,'');
    assert.equal(calls.filter(c=>c.options.method==='POST'&&/\/(tracks|items)(?:\?|$)/.test(c.url)).length,1);
    assert.equal((await post('import',{confirm:true,target:pid,revision:'consumed',selections:[expectedId]})).response.status,400);
  }
});
