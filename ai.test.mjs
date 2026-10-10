import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTracks, validateAnalysis, validateRecommendations, normalizeFeedback, MusicAI, AI_MODEL, AI_PROVIDERS } from './ai.mjs';
import { createApp } from './server.mjs';
import { Demo } from './demo.mjs';

const input = [{ title: 'So Sick', artist: 'Ne-Yo', album: 'In My Own Words', year: 2006 }];
const payload = () => ({ summary: '具体点评', tracks: [{ ref: 't1', known: true, confidence: 'high', genres: ['R&B'], scores: { rhythm: 3, energy: 2, vocals: 4, acoustic: 2.5, atmosphere: 3 }, reason: '作品资料判断' }], strengths: [{ text: '以人声为中心', refs: ['t1'] }], blindspots: [], recommendations: [{ title: 'Sweet Love', artist: 'Anita Baker', reason: '人声与 Soul 编排的延伸', refs: ['t1'] }] });
const response = raw => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(raw) } }] }), { status: 200 });
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); } assert.fail('AI task did not settle'); }

test('feedback has bounded song-only fields, latest marks win and unsupported values are discarded', () => {
  const values = normalizeFeedback([{ title:'Song',artist:'Artist',mark:'like',Cookie:'private',key:'private' }, { title:'Ｓｏｎｇ',artist:'Artist',mark:'heard' }, { title:'Bad',artist:'Artist',mark:'command' }, {title:{secret:'private'},artist:'Artist',mark:'like'}]);
  assert.equal(values.length, 1); assert.equal(values[0].mark, 'heard'); assert.equal(JSON.stringify(values).includes('private'), false);
  assert.equal(normalizeFeedback(Array.from({length:250},(_,i)=>({title:'Song'+i,artist:'Artist',mark:'like'}))).length,200);
});

test('all marked songs are excluded, feedback changes one recommendation call without modifying the profile', async () => {
  const requests = [], marks = ['like','less','heard'];
  const feedback = marks.map((mark,i)=>({title:'Marked'+i,artist:'Artist',mark,Cookie:'do-not-send'}));
  const ai = new MusicAI({transport:async(_,options)=>{
    const body = JSON.parse(options.body), data = JSON.parse(body.messages[1].content); requests.push({body,data});
    return response(data.profile ? {recommendations:[...feedback.map(value=>({...value,reason:'reason',refs:['t1']})),{title:'Fresh',artist:'Artist',reason:'reason',refs:['t1']}]} : payload());
  }});
  ai.configure({key:'private-key'}); ai.start({tracks:input}); await until(()=>ai.job.state!=='running');
  const before=ai.job.result, fingerprint=before.source.fingerprint;
  ai.startRecommendations({fingerprint,feedback}); await until(()=>ai.job.state!=='running');
  assert.equal(requests.length,2); assert.equal(ai.job.state,'completed'); assert.equal(ai.job.result.recommendations.length,1); assert.equal(ai.job.result.recommendations[0].title,'Fresh');
  assert.equal(ai.job.result.axes,before.axes); assert.equal(ai.job.result.observations,before.observations);
  assert.deepEqual(requests[1].data.feedback.map(value=>value.mark),marks); assert.equal(JSON.stringify(requests[1].data).includes('do-not-send'),false);
  assert.match(requests[1].body.messages[0].content,/heard只表示听过/);
  ai.startRecommendations({fingerprint,feedback:[]}); await until(()=>ai.job.state!=='running');
  assert.deepEqual(requests[2].data.feedback,[]); assert.deepEqual(ai.job.result.feedback,[]);
});

test('persistent feedback stays out of scoring batches and is used only for summary recommendations', async () => {
  const requests=[], feedback=[{title:'Remembered',artist:'Artist',mark:'like'}];
  const ai=new MusicAI({transport:async(_,options)=>{
    const data=JSON.parse(JSON.parse(options.body).messages[1].content); requests.push(data);
    return response(data.observations ? payload() : {tracks:data.tracks.map(track=>({...payload().tracks[0],ref:track.ref}))});
  }});
  ai.configure({key:'private-key'}); ai.start({tracks:Array.from({length:40},(_,i)=>({title:'Track'+i,artist:'Artist'})),feedback}); await until(()=>ai.job.state!=='running');
  assert.equal(ai.job.state,'completed'); assert.ok(requests.slice(0,2).every(value=>!Object.hasOwn(value,'feedback')));
  assert.deepEqual(requests[2].feedback,feedback); assert.deepEqual(ai.job.result.feedback,feedback);
});

test('malformed recommendation output asks for a new recommendation rather than a smaller analysis', async () => {
  let first=true;
  const ai=new MusicAI({transport:async()=>{if(first){first=false;return response(payload());}return new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{'}}]}));}});
  ai.configure({key:'private-key'}); ai.start({tracks:input}); await until(()=>ai.job.state!=='running');
  const before=ai.job.result;
  ai.startRecommendations({fingerprint:before.source.fingerprint}); await until(()=>ai.job.state!=='running');
  assert.equal(ai.job.state,'error'); assert.equal(ai.job.result,before); assert.match(ai.job.error,/推荐回复.*重新生成/); assert.doesNotMatch(ai.job.error,/图表|减少歌曲/);
});

test('AI input is limited, deduplicated and contains no credential fields', () => {
  const tracks = prepareTracks([...input, { ...input[0], Cookie: 'secret', apiKey: 'secret' }]);
  assert.equal(tracks.length, 1); assert.equal(tracks[0].ref, 't1'); assert.equal(tracks[0].year, 2006);
  assert.equal(JSON.stringify(tracks).includes('secret'), false);
  assert.throws(() => prepareTracks([])); assert.throws(() => prepareTracks([{ title: '' }]));
  assert.throws(() => prepareTracks(Array.from({ length: 201 }, (_, i) => ({ title: String(i) }))));
});
test('unknown songs and invalid scores do not become fabricated radar values', () => {
  const tracks = prepareTracks(input), raw = payload();
  raw.tracks[0].scores.energy = 100;
  raw.strengths.push({ text: '伪造引用', refs: ['outside'] });
  raw.recommendations.push({ title: 'Invented', artist: 'Someone', refs: ['outside'] });
  raw.recommendations.push({ ...raw.recommendations[0] });
  let result = validateAnalysis(raw, tracks);
  assert.equal(result.axes.find(axis => axis.id === 'energy').value, null);
  assert.equal(result.strengths.length, 1); assert.equal(result.recommendations.length, 1);
  assert.equal(result.axes.find(axis => axis.id === 'diversity').value, 0);
  raw.tracks[0].known = false;
  result = validateAnalysis(raw, tracks);
  assert.ok(result.axes.every(axis => axis.value === null)); assert.equal(result.coverage.known, 0);
});
test('genre breadth is calculated from distribution rather than model taste scoring', () => {
  const tracks = prepareTracks(Array.from({ length: 8 }, (_, i) => ({ title: String(i), artist: 'test' })));
  const raw = payload(); raw.tracks = tracks.map((track, i) => ({ ...payload().tracks[0], ref: track.ref, genres: ['genre' + i] }));
  assert.equal(validateAnalysis(raw, tracks).axes[5].value, 5);
  raw.tracks.forEach(track => track.genres = ['same']);
  assert.equal(validateAnalysis(raw, tracks).axes[5].value, 0);
});
test('default analysis covers all loaded songs; optional fast sampling retains honest total and exclusions', async () => {
  const demo = new MusicAI({ demo: true });
  demo.start({ tracks: Array.from({ length: 150 }, (_, index) => ({ title: 'track' + index, artist: 'test' })), total: 900, sampled: true });
  await until(() => demo.job.state !== 'running');
  const source = demo.job.result.source;
  assert.equal(source.tracks.length, 150); assert.equal(source.tracks[0].title, 'track0'); assert.equal(source.tracks.at(-1).title, 'track149');
  assert.equal(source.total, 900); assert.equal(source.sampled, true); assert.equal(demo.job.result.coverage.total, 150);
  const ai = new MusicAI({ transport: async () => response(payload()) });
  ai.configure({ key: 'test-key' });
  const fullList = Array.from({ length: 150 }, (_, index) => ({ title: 'track' + index, artist: 'test' }));
  fullList[1] = { title: 'Sweet Love', artist: 'Anita Baker' };
  ai.start({ tracks: fullList, limit: 40 }); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.result.source.tracks.length, 40);
  assert.equal(ai.job.result.source.tracks.some(track => track.title === 'Sweet Love'), false);
  assert.equal(ai.job.result.recommendations.length, 0, 'recommendations exclude existing songs outside the analysis sample');
});

test('200-song analysis is serial and complete; review cannot replace per-song scores', async () => {
  const calls = [], tracks = Array.from({ length: 200 }, (_, i) => ({ title: 'Song' + i, artist: 'Artist' + i }));
  const ai = new MusicAI({ transport: async (_, options) => {
    const body = JSON.parse(options.body), data = JSON.parse(body.messages[1].content); calls.push(data);
    if (data.observations) return response({ summary: '全歌单汇总', tracks: [{ ref: 't1', scores: { acoustic: 5 } }], recommendations: [] });
    return response({ tracks: data.tracks.map(track => ({ ...payload().tracks[0], ref: track.ref, scores: { ...payload().tracks[0].scores, acoustic: 1 }, axisReasons: { acoustic: '独立器乐展开少，主要维持伴奏，因此为1分。' } })) });
  } });
  ai.configure({ key: 'private-test-key' }); ai.start({ tracks }); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'completed'); assert.equal(calls.length, 8);
  assert.ok(calls.slice(0,-1).every(call => call.tracks.length <= 32));
  assert.equal(ai.job.result.coverage.known, 200); assert.equal(ai.job.result.coverage.total, 200);
  const axis = ai.job.result.axes.find(axis => axis.id === 'acoustic');
  assert.equal(axis.value, 1); assert.equal(axis.count, 200); assert.match(axis.explanation, /200 首/);
  assert.match(ai.job.result.observations[0].axisReasons.acoustic, /因此为1分/);
});

test('a partial batch failure is not retried automatically; explicit restart reuses completed judgments', async () => {
  let calls = 0, fail = true;
  const ai = new MusicAI({ transport: async (_, options) => {
    calls++; const data = JSON.parse(JSON.parse(options.body).messages[1].content);
    if (calls === 2 && fail) return new Response('secret-provider-body', { status: 429 });
    return response(data.observations ? { summary: '汇总', tracks: [] } : { tracks: data.tracks.map(track => ({ ...payload().tracks[0], ref: track.ref })) });
  } });
  const tracks = Array.from({ length: 77 }, (_, i) => ({ title: 'Track' + i, artist: 'Artist' }));
  ai.configure({ key: 'private-key' }); ai.start({ tracks }); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'error'); assert.equal(calls, 2); assert.equal(ai.job.progress.done, 32);
  fail = false; ai.start({ tracks }); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'completed'); assert.equal(calls, 5); assert.equal(ai.job.result.coverage.known, 77);
});

test('low overall scores cite representative low songs and preserve independent dimension reasons', () => {
  const tracks = prepareTracks(Array.from({ length: 5 }, (_, i) => ({ title: 'Track' + i, artist: 'Artist' })));
  const raw = { tracks: tracks.map((track, i) => ({ ...payload().tracks[0], ref: track.ref, scores: { acoustic: i === 4 ? 3 : .5 }, axisReasons: { acoustic: i === 4 ? '作为高于整体的对照，器乐展开中等。' : '器乐主要重复维持伴奏，展开很少，因此低分。' }, reason: '这是通用介绍，不应代替维度理由。' })) };
  const result = validateAnalysis(raw, tracks), axis = result.axes.find(axis => axis.id === 'acoustic');
  assert.equal(axis.value, 1); assert.notEqual(axis.evidence[0], 't5'); assert.ok(axis.evidence.includes('t5'));
  assert.match(result.observations[0].axisReasons.acoustic, /因此低分/); assert.match(axis.definition, /电子乐器/);
});

test('recommendation direction is a separate single request with history exclusions and unchanged analysis', async () => {
  const calls = [];
  const ai = new MusicAI({ transport: async (_, options) => {
    const body = JSON.parse(options.body), data = JSON.parse(body.messages[1].content); calls.push({ body, data });
    if (!data.profile) return response(payload());
    const rec = { title: 'New Song ' + calls.length, artist: 'New Artist', connection: '律动连接', difference: '跨到另一流派', lane: data.direction === 'adventurous' ? 'cross' : 'neighbor', refs: ['t1'] };
    return response({ recommendations: [{ ...rec, title: 'Sweet Love', artist: 'Anita Baker' }, { ...rec, title: 'So Sick', artist: 'Ne-Yo' }, rec] });
  } });
  ai.configure({ key: 'private-key' }); ai.start({ tracks: input }); await until(() => ai.job.state !== 'running');
  const before = ai.job.result, scores = JSON.stringify(before.axes), fingerprint = before.source.fingerprint;
  ai.startRecommendations({ fingerprint, direction: 'adventurous', preferences: '保留律动' }); await until(() => ai.job.state !== 'running');
  assert.equal(calls.length, 2); assert.equal(ai.job.state, 'completed'); assert.equal(ai.job.kind, 'recommendations');
  assert.equal(JSON.stringify(ai.job.result.axes), scores); assert.equal(ai.job.result.summary, before.summary);
  assert.equal(ai.job.result.recommendations.length, 1); assert.equal(ai.job.result.direction, 'adventurous');
  assert.ok(calls[1].data.exclude.some(track => track.title === 'Sweet Love')); assert.match(calls[1].body.messages[0].content, /至少三个/);
  ai.startRecommendations({ fingerprint, direction: 'expand' }); await until(() => ai.job.state !== 'running');
  assert.ok(calls[2].data.exclude.some(track => track.title === 'New Song 2'));
  assert.throws(() => ai.startRecommendations({ fingerprint: 'wrong' }), /来源已改变/);
});

test('invalid recommendations retain the previous batch and late canceled output cannot replace it', async () => {
  let mode = 'initial', release;
  const ai = new MusicAI({ transport: async () => mode === 'late' ? new Promise(resolve => release = resolve) : response(mode === 'initial' ? payload() : { recommendations: [{ ...payload().recommendations[0], connection: '连接', difference: '变化', lane: 'cross' }] }) });
  ai.configure({ key: 'private-key' }); ai.start({ tracks: input }); await until(() => ai.job.state !== 'running');
  const before = ai.job.result, fingerprint = before.source.fingerprint;
  mode = 'duplicates'; ai.startRecommendations({ fingerprint, direction: 'adventurous' }); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'error'); assert.equal(ai.job.result, before); assert.match(ai.job.error, /1 首.*重复/);
  mode = 'late'; ai.startRecommendations({ fingerprint, direction: 'adventurous' }); ai.cancel(true);
  release(response({ recommendations: [{ title: 'Late Song', artist: 'Artist', connection: '连接', difference: '变化', lane: 'cross', refs: ['t1'] }] }));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(ai.job.result, before);
});

test('optional direction fields cannot reject grounded new songs and duplicates before item 12 do not hide later new candidates', () => {
  const tracks = prepareTracks(input), old = payload().recommendations[0];
  const candidates = [...Array.from({ length: 15 }, () => old), { title: 'Later New Song', artist: 'Artist', reason: '具体连接原曲的人声表现', refs: ['t1'] }];
  const result = validateRecommendations(candidates, tracks, [old]);
  assert.equal(result.recommendations.length, 1); assert.equal(result.recommendations[0].title, 'Later New Song');
  assert.equal(result.recommendations[0].lane, ''); assert.equal(result.diagnostics.repeated, 15);
  const invalid = validateRecommendations([{ title:'New Song', artist:'Artist', reason:'reason', refs:['outside'] }, { title:'New Song 2', artist:'Artist', refs:['t1'] }], tracks);
  assert.equal(invalid.recommendations.length, 0); assert.equal(invalid.diagnostics.invalidReferences, 1); assert.equal(invalid.diagnostics.noReason, 1);
});

test('a real recommendation request accepts reason and source refs without optional fields and reports precise rejected counts', async () => {
  let mode = 'initial', calls = 0;
  const ai = new MusicAI({ transport: async () => {
    calls++;
    if (mode === 'initial') return response(payload());
    return response(mode === 'new' ? { recommendations:[{title:'Fresh Song',artist:'Fresh Artist',reason:'编排与引用作品相邻',refs:['t1']}] } : {recommendations:[payload().recommendations[0],{title:'Bad Ref',artist:'Artist',reason:'why',refs:['outside']}]});
  } });
  ai.configure({key:'private-key'}); ai.start({tracks:input}); await until(() => ai.job.state !== 'running');
  const fingerprint = ai.job.result.source.fingerprint;
  mode = 'new'; ai.startRecommendations({fingerprint,direction:'expand'}); await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state,'completed'); assert.equal(ai.job.result.recommendations[0].title,'Fresh Song');
  mode = 'rejected'; ai.startRecommendations({fingerprint,direction:'adventurous'}); await until(() => ai.job.state !== 'running');
  assert.equal(calls,3); assert.equal(ai.job.state,'error'); assert.match(ai.job.error,/AI 返回 2.*1 首.*重复.*1 首.*引用/);
  assert.equal(ai.job.result.recommendations[0].title,'Fresh Song'); assert.equal(ai.job.settings.direction,'adventurous');
});

test('recommendation preferences stay out of batch scoring and an explicitly empty preference clears the previous one', async () => {
  const requests = [];
  const ai = new MusicAI({ transport: async (_,options) => {
    const data = JSON.parse(JSON.parse(options.body).messages[1].content); requests.push(data);
    if (data.profile) return response({recommendations:[{title:'Fresh',artist:'Artist',reason:'reason',refs:['t1']}]});
    return response(data.observations ? payload() : {tracks:data.tracks.map(track => ({...payload().tracks[0],ref:track.ref}))});
  } });
  ai.configure({key:'private-key'}); ai.start({tracks:Array.from({length:40},(_,i)=>({title:'Song'+i,artist:'Artist'})), recommendationPreferences:'避开低动态'}); await until(()=>ai.job.state!=='running');
  assert.ok(requests.slice(0,2).every(data => !Object.hasOwn(data,'recommendationPreferences')));
  assert.equal(requests[2].recommendationPreferences,'避开低动态');
  assert.equal(ai.job.result.recommendationPreferences,'避开低动态');
  ai.startRecommendations({fingerprint:ai.job.result.source.fingerprint,direction:'expand',preferences:''}); await until(()=>ai.job.state!=='running');
  assert.equal(requests.at(-1).preferences,''); assert.equal(ai.job.result.recommendationPreferences,'');
});
test('real AI uses only fixed free model endpoint and does not expose its key', async () => {
  let request;
  const ai = new MusicAI({ transport: async (url, options) => { request = { url, options }; return response(payload()); } });
  assert.throws(() => ai.start({ tracks: input }), /Key/);
  ai.configure({ key: 'test-secret-key' }); ai.start({ tracks: input, tone: 'sharp', direction: 'familiar' });
  await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'completed'); assert.equal(request.url, 'https://open.bigmodel.cn/api/paas/v4/chat/completions');
  const body = JSON.parse(request.options.body);
  assert.equal(body.model, AI_MODEL); assert.equal(request.options.redirect, 'error'); assert.equal(body.stream, false);
  assert.equal(request.options.body.includes('test-secret-key'), false);
  assert.equal(JSON.stringify(ai.status()).includes('test-secret-key'), false); assert.equal(JSON.stringify(ai.job).includes('test-secret-key'), false);
  assert.equal(ai.job.result.tone, 'sharp'); assert.equal(ai.job.result.direction, 'familiar');
});
test('provider errors are redacted and not automatically retried', async () => {
  let calls = 0;
  const ai = new MusicAI({ transport: async () => { calls++; return new Response('leaked-test-key', { status: 429 }); } });
  ai.configure({ key: 'leaked-test-key' }); ai.start({ tracks: input }); await until(() => ai.job.state !== 'running');
  assert.equal(calls, 1); assert.equal(ai.job.state, 'error'); assert.match(ai.job.error, /限额/); assert.equal(ai.job.error.includes('leaked-test-key'), false);
});
test('oversized, malformed and truncated responses do not produce a profile', async () => {
  for (const result of [new Response('x'.repeat(500001)), new Response('{bad json'), new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: { content: '{}' } }] }))]) {
    const ai = new MusicAI({ transport: async () => result }); ai.configure({ key: 'test-key' }); ai.start({ tracks: input }); await until(() => ai.job.state !== 'running'); assert.equal(ai.job.state, 'error');
  }
});
test('clearing key invalidates late responses and demo never accepts credentials', async () => {
  let release;
  const ai = new MusicAI({ transport: () => new Promise(resolve => release = resolve) });
  ai.configure({ key: 'test-key' }); ai.start({ tracks: input }); ai.configure({ clear: true }); release(response(payload())); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ai.job.state, 'idle'); assert.equal(ai.status().configured, false);
  const demo = new MusicAI({ demo: true }); assert.throws(() => demo.configure({ key: 'test-key' }), /不接收/);
  demo.start({ tracks: input }); await until(() => demo.job.state !== 'running'); assert.equal(demo.job.result.demo, true); assert.match(demo.job.result.summary, /不是.*真实评定/);
});
test('AI status polling cannot release another platform request lock', async t => {
  const demo = new Demo(); let release;
  demo.readPlaylist = () => new Promise(resolve => release = resolve);
  const app = createApp(demo, { demo: true }); await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, body = {}) => fetch(base + '/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token }, body: JSON.stringify(body) });
  const pending = post('playlist/read', { target: '90001' }); await until(() => !!release);
  assert.equal((await post('ai/status')).status, 200); assert.equal((await post('playlists')).status, 409);
  release({ tracks: input }); assert.equal((await pending).status, 200);
});

test('each provider uses its official endpoint and its own credential; paid configurations require consent', async () => {
  const calls = [];
  const ai = new MusicAI({ transport: async (url, options) => { calls.push({ url, options }); return response(payload()); } });
  ai.configure({ key: 'zhipu-private' });
  assert.throws(() => ai.configure({ provider: 'deepseek', confirmCost: true }), /Key/);
  assert.throws(() => ai.configure({ provider: 'deepseek', key: 'deepseek-private' }), /费用/);
  assert.equal(ai.status().provider, 'zhipu');
  assert.throws(() => ai.configure({ provider: 'untrusted', key: 'private', confirmCost: true }), /服务/);
  assert.throws(() => ai.configure({ provider: 'zhipu', model: 'https://arbitrary.example', key: 'private' }), /模型/);
  for (const [provider, definition] of Object.entries(AI_PROVIDERS)) {
    ai.configure({ provider, key: provider + '-private', confirmCost: provider !== 'zhipu' });
    ai.start({ tracks: input }); await until(() => ai.job.state !== 'running');
    assert.equal(ai.job.state, 'completed');
    const request = calls.at(-1);
    assert.equal(request.url, definition.endpoint);
    assert.equal(request.options.headers.Authorization, 'Bearer ' + provider + '-private');
    assert.equal(JSON.parse(request.options.body).model, definition.defaultModel);
    assert.equal(ai.job.result.provider, provider);
    assert.equal(JSON.stringify(ai.status()).includes('-private'), false);
  }
  ai.configure({ provider: 'zhipu' });
  ai.start({ tracks: input }); await until(() => ai.job.state !== 'running');
  assert.equal(calls.at(-1).options.headers.Authorization, 'Bearer zhipu-private');
  ai.configure({ provider: 'deepseek', clear: true });
  assert.equal(ai.status().configured, false);
  assert.equal(ai.status().providers.find(value => value.id === 'zhipu').configured, true);
  ai.configure({ provider: 'zhipu', clearAll: true });
  assert.ok(ai.status().providers.every(value => !value.configured));
});

test('switching provider invalidates a late result and never falls back after a provider failure', async () => {
  let release, calls = 0;
  const ai = new MusicAI({ transport: () => { calls++; return new Promise(resolve => release = resolve); } });
  ai.configure({ key: 'zhipu-private' }); ai.start({ tracks: input });
  ai.configure({ provider: 'deepseek', key: 'deepseek-private', confirmCost: true });
  release(response(payload())); await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(ai.job.state, 'idle');
  ai.start({ tracks: input }); release(new Response('unauthorized', { status: 401 }));
  await until(() => ai.job.state !== 'running');
  assert.equal(ai.job.state, 'error'); assert.equal(calls, 2);
  assert.equal(ai.status().provider, 'deepseek');
});
