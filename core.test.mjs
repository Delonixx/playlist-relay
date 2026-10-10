import test from 'node:test';
import assert from 'node:assert/strict';
import { parseList, rank, playlistId, selectedIds, appendVerified, withFavoritePreference, coverUrl } from './core.mjs';
import { createApp } from './server.mjs';
import { Demo } from './demo.mjs';
import http from 'node:http';
test('parse ChatGPT bullets, apostrophes and artist hyphens; deduplicate', () => {
  assert.deepEqual(parseList("1. **So Sick** — Ne-Yo\n- So Sick — Ne-Yo\nThat's Enough for Me | Patti Austin"), [{title:'So Sick',artist:'Ne-Yo'},{title:"That's Enough for Me",artist:'Patti Austin'}]);
  assert.equal(parseList('Ne-Yo — So Sick', 'artist-first')[0].title, 'So Sick');
  assert.equal(parseList('Yellow')[0].artist, '');
  assert.throws(() => parseList(''), /请输入/);
  assert.throws(() => parseList('歌名 — 歌手 — 理由'), /去掉/);
});
const song = (id, name, artist) => ({id,name,ar:[{name:artist}],al:{name:'album'}});
test('type-conflicted QQ candidates can be browsed but favorite ranking and manual selection cannot authorize import', () => {
  const row = rank({ title: 'Song', artist: 'Artist' }, [{ ...song('1','Song','Artist'), platform: 'qq', writeBlocked: true }, { ...song('2','Song','Artist'), platform: 'qq' }]);
  const preferred = withFavoritePreference(row, { '1': 9000000, '2': 100 });
  assert.equal(preferred.candidates.length, 2); assert.equal(preferred.selected, '2');
  assert.throws(() => selectedIds([preferred], ['1']), /类型信息不一致/);
  assert.deepEqual(selectedIds([preferred], ['2']), ['2']);
});
test('favorites select only exact editions; Live and other singers cannot replace the recording', () => {
  const row = rank({ title: 'So Sick', artist: 'Ne-Yo' }, [song(1, 'So Sick', 'Ne-Yo'), song(2, 'So Sick', 'Ne-Yo'), song(3, 'So Sick (Live)', 'Ne-Yo'), song(4, 'So Sick', 'Other')]);
  assert.equal(withFavoritePreference(row, { 1: 0, 2: 30, 3: 999, 4: 999 }).selected, '2');
  assert.match(row.selectionReason, /30 人收藏/);
  withFavoritePreference(row, { 1: 30, 2: 30 }); assert.equal(row.selected, ''); assert.match(row.selectionReason, /并列/);
  const partial = withFavoritePreference(rank({ title: 'So Sick', artist: 'Ne-Yo' }, [song(1, 'So Sick', 'Ne-Yo'), song(2, 'So Sick', 'Ne-Yo')]), { 1: 30 });
  assert.equal(partial.selected, ''); assert.equal(partial.favoriteStatus, 'unavailable');
});
test('platform favorite estimates keep their original display and never claim an exact maximum', () => {
  const row = withFavoritePreference(rank({ title: 'So Sick', artist: 'Ne-Yo' }, [song(1, 'So Sick', 'Ne-Yo'), song(2, 'So Sick', 'Ne-Yo')]), { 1: { value: 3400000, display: '340w+', approximate: true }, 2: { value: 57000000, display: '5700w+', approximate: true } });
  assert.equal(row.selected, '2'); assert.match(row.selectionReason, /平台收藏量级.*5700w\+/); assert.doesNotMatch(row.selectionReason, /人收藏|收藏最多/);
});
test('QQ links and covers are restricted to their actual platform domains', () => {
  assert.equal(playlistId('https://y.qq.com/n/ryqq/playlist/123', 'qq'), '123');
  assert.equal(playlistId('https://y.qq.com/n/m/detail/taoge/index.html?id=456', 'qq'), '456');
  assert.throws(() => playlistId('https://music.163.com/playlist?id=123', 'qq'));
  assert.throws(() => playlistId('https://y.qq.com.evil.test/playlist/123', 'qq'));
  assert.equal(coverUrl('http://y.gtimg.cn/music/photo_new/album.jpg'), 'https://y.gtimg.cn/music/photo_new/album.jpg');
  assert.equal(coverUrl('https://y.gtimg.cn/unrelated/album.jpg'), '');
});
test('never auto select missing artists, covers, different versions or duplicate editions', () => {
  const row = {title:'So Sick',artist:'Ne-Yo'};
  const s = [song(1,'So Sick (Live)','Ne-Yo'),song(2,'So Sick','Ne-Yo'),song(3,'So Sick','Cover Singer')];
  assert.equal(rank(row,s).selected,'2');
  assert.equal(rank({...row,artist:''},s).selected,'');
  assert.equal(rank(row,[s[0]]).selected,'');
  assert.equal(rank(row,[s[2]]).selected,'');
  assert.equal(rank(row,[s[1],song(4,'So Sick','Ne-Yo')]).selected,'');
  assert.equal(rank(row,[]).status,'未找到');
});
test('target parsing and server-side candidate allowlist', () => {
  assert.equal(playlistId('https://music.163.com/#/playlist?id=123'),'123');
  assert.equal(playlistId('https://y.music.163.com/m/playlist?id=456'),'456');
  assert.throws(() => playlistId('https://evil.test/playlist?id=123'));
  const rows = [rank({title:'x',artist:'y'},[song(1,'x','y')])];
  assert.deepEqual(selectedIds(rows,['1']),['1']);
  assert.throws(() => selectedIds(rows,['999']));
});
test('skip existing IDs; batches are read back; ownership enforced', async () => {
  const d = new Demo(); d.ids = ['1'];
  const ids = Array.from({length:23},(_,i)=>String(i+1));
  const r = await appendVerified(d,'90001','demo',ids);
  assert.equal(r.verified.length,22); assert.deepEqual(r.skipped,['1']); assert.equal(r.stopped,'');
  await assert.rejects(appendVerified(d,'90001','someone-else',['100']),/自己/);
});
test('ambiguous timeout stops writes without retry, retaining entire unresolved tail', async () => {
  const d = new Demo(); d.ids = []; let calls=0;
  d.add = async () => { calls++; throw new Error('timeout'); };
  const r = await appendVerified(d,'90001','demo',Array.from({length:25},(_,i)=>String(i+1)));
  assert.equal(calls,1); assert.equal(r.unverified.length,25); assert.equal(r.verified.length,0);
});
test('partial acceptance is not called success; no subsequent batch', async () => {
  const d = new Demo(); d.ids=[]; let calls=0;
  d.add=async(pid,ids)=>{calls++;d.ids.push(ids[0]);};
  const r = await appendVerified(d,'90001','demo',Array.from({length:15},(_,i)=>String(i+1)));
  assert.equal(calls,1); assert.equal(r.verified.length,1); assert.equal(r.unverified.length,14); assert.ok(r.stopped);
});
test('HTTP security and complete offline matching/import path', async () => {
  const app = createApp(new Demo(),{demo:true});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  const post=async(route,data={},extra={})=>fetch(base+'/api/'+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token,...extra},body:JSON.stringify(data)});
  try {
    assert.equal((await fetch(base)).status,200);
    assert.equal((await post('status',{}, {'X-Local-Token':'wrong'})).status,403);
    assert.equal((await post('status',{}, {Origin:'https://evil.test'})).status,403);
    const badHost = await new Promise(resolve => {
      const req=http.request(base+'/api/status',{method:'POST',headers:{Host:'evil.test','Content-Type':'application/json','X-Local-Token':app.token}},res=>{res.resume();resolve(res.statusCode);});
      req.end('{}');
    });
    assert.equal(badHost,403);
    assert.equal((await fetch(base+'/api/import')).status,403);
    assert.equal((await post('import',{confirm:true,revision:'missing'})).status,400);
    await post('match',{text:'So Sick — Ne-Yo',target:'90001'});
    let job; for(let i=0;i<10;i++){job=await(await post('job')).json();if(job.state==='matched')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(job.state,'matched');
    assert.equal((await post('import',{confirm:false})).status,400);
    const result=await post('import',{confirm:true,target:'90001',revision:job.revision,selections:[job.rows[0].selected]});
    assert.equal(result.status,202);
    for(let i=0;i<10;i++){job=await(await post('job')).json();if(job.state==='imported')break;await new Promise(r=>setTimeout(r,5));}
    assert.equal(job.report.verified.length,1);
    assert.equal((await post('import',{confirm:true,target:'90001',revision:'replay',selections:['1']})).status,400);
  } finally { await new Promise(r=>app.server.close(r)); }
});
