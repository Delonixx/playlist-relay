import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createApp } from './server.mjs';
import { Demo } from './demo.mjs';
import { MusicAI } from './ai.mjs';

// DOM contract fixture; deliberately not a renderer or visual QA substitute.
class Node {
  constructor(tag = '') {
    this.tagName = tag.toUpperCase(); this.children = []; this.parent = null;
    this.listeners = {}; this.attributes = {}; this.dataset = {}; this.value = ''; this._text = '';
    this.disabled = false; this.checked = false; this.open = false; this.classes = new Set();
    this.classList = { toggle: (name, force) => { const on = force ?? !this.classes.has(name); on ? this.classes.add(name) : this.classes.delete(name); return on; }, contains: name => this.classes.has(name) };
  }
  set className(value) { this.classes = new Set(value.split(/\s+/).filter(Boolean)); }
  get className() { return [...this.classes].join(' '); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = value;
    if (name === 'id') this.id = value;
    if (name === 'disabled') this.disabled = true;
    if (name === 'value') this.value = value;
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
  }
  append(...nodes) { for (const node of nodes) { if (node.tagName === 'FRAGMENT') this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
  replaceChildren(...nodes) { this.children = []; this._text = ''; this.append(...nodes); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
  addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
  async fire(name) { for (const handler of this.listeners[name] || []) await handler({ target: this, currentTarget: this }); }
  async click() { if (!this.disabled) await this.fire('click'); }
  closest(selector) { let node = this; while (node && !matches(node, selector)) node = node.parent; return node; }
  showModal() { this.open = true; }
  close() { this.open = false; queueMicrotask(() => this.fire('close')); }
  focus() {}
  scrollIntoView() {}
}
function matches(node, selector) {
  const parts = selector.trim().split(/\s+/), last = parts.pop();
  const own = last.startsWith('.') ? node.classes.has(last.slice(1)) : last.startsWith('#') ? node.id === last.slice(1) : node.tagName === last.toUpperCase();
  return own && (!parts.length || !!node.parent?.closest(parts.join(' ')));
}
function walk(node) { return [node, ...node.children.flatMap(walk)]; }
function dom(html) {
  const root = new Node('document'), stack = [root];
  for (const token of html.match(/<[^>]+>|[^<]+/g)) {
    if (token.startsWith('<!')) continue;
    if (token.startsWith('</')) { stack.pop(); continue; }
    if (token.startsWith('<')) {
      const tag = token.match(/^<([\w-]+)/)[1], node = new Node(tag);
      for (const attr of token.slice(tag.length + 1, -1).matchAll(/([\w-]+)(?:="([^"]*)")?/g)) node.setAttribute(attr[1], attr[2] ?? '');
      stack.at(-1).append(node);
      if (!['meta', 'link', 'input', 'img', 'br', 'hr'].includes(tag)) stack.push(node);
    } else if (token.trim()) stack.at(-1)._text += token;
  }
  const byId = new Map(walk(root).filter(node => node.id).map(node => [node.id, node]));
  byId.get('input-order').value = 'title-first'; byId.get('input-privacy').value = '10';
  byId.get('prune-mode').value='rules';byId.get('prune-rule').value='live';
  return {
    body: walk(root).find(node => node.tagName === 'BODY'),
    getElementById: id => { assert.ok(byId.has(id), 'missing HTML control: ' + id); return byId.get(id); },
    createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag), createDocumentFragment: () => new Node('fragment'),
    querySelectorAll: selector => walk(root).filter(node => selector.split(',').some(part => matches(node, part))),
    nodes: () => walk(root)
  };
}
const html = await readFile(new URL('./public/index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('./public/app.js', import.meta.url), 'utf8');
const studioSource = await readFile(new URL('./public/studio.js', import.meta.url), 'utf8');
const pruneSource = await readFile(new URL('./public/prune.js', import.meta.url), 'utf8');
async function until(check) {
  for (let attempt = 0; attempt < 200; attempt++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('frontend did not reach expected state');
}
async function fixture(t, { badToken = false, adapter = new Demo(), withStudio = false, withPrune = false, demo = true, ai, adapters, qrPollDelay, storage = new Map(), storageBlocked = false } = {}) {
  const app = createApp(adapter, { demo, ai, adapters });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const document = dom(html), calls = [], timers = [];
  const context = vm.createContext({ document, location: { hash: '#' + (badToken ? 'invalid' : app.token) }, history: { replaceState() {} },
    fetch: (url, options) => { calls.push({ url, body: JSON.parse(options.body) }); return fetch(base + url, options); },
    setTimeout: (fn, delay) => { const timer = setTimeout(fn, delay === 3500 && qrPollDelay ? qrPollDelay : delay); timers.push(timer); return timer; },
    clearTimeout, queueMicrotask, Blob, localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('storage denied'); storage.set(key, String(value)); },
      removeItem(key) { if (storageBlocked) throw new Error('storage denied'); storage.delete(key); }
    }, URL: class extends URL { static createObjectURL() { return 'blob:test'; } static revokeObjectURL() {} },
    matchMedia: () => ({ matches: true }), navigator: { clipboard: { writeText: async () => {} } } });
  vm.runInContext(source, context);
  if (withStudio || withPrune) vm.runInContext(studioSource, context);
  if (withPrune) vm.runInContext(pruneSource, context);
  const state = () => vm.runInContext('state', context), get = document.getElementById;
  const studio = () => withStudio || withPrune ? vm.runInContext('studio', context) : null;
  t.after(async () => { timers.forEach(clearTimeout); app.server.closeAllConnections(); await new Promise(resolve => app.server.close(resolve)); });
  await until(() => !state().pending && (!(withStudio || withPrune) || studio().ready));
  return { document, get, state, studio, calls, app, base, storage, context };
}

test('pruning UI previews complete playlist, honors deselection, and writes only after separate confirmation',async t=>{
  const adapter=new Demo(),{get,calls,context,document}=await fixture(t,{adapter,withPrune:true});
  const current=()=>vm.runInContext('prune',context);
  get('input-target').value='90001';await get('input-target').fire('input');
  await document.querySelectorAll('.nav-item').find(value=>value.dataset.page==='prune').click();
  assert.equal(get('page-prune').classList.contains('hidden'),false);assert.equal(get('page-analysis').classList.contains('hidden'),true);
  await get('btn-prune-prepare').click();await until(()=>current().preview&&!current().busy);
  assert.equal(calls.some(value=>value.url==='/api/prune/execute'),false);assert.equal(adapter.ids.length,1);assert.match(get('prune-count').textContent,/1 首建议 \/ 1 首已检查/);
  await get('btn-prune-select-none').click();assert.equal(get('btn-prune-review').disabled,true);
  await get('btn-prune-select-all').click();await get('btn-prune-review').click();assert.equal(get('modal-prune-confirm').open,true);assert.match(get('prune-confirm-description').textContent,/移出 1 首/);
  assert.equal(calls.some(value=>value.url==='/api/prune/execute'),false);
  await get('btn-prune-execute').click();await until(()=>current().report&&!current().busy);
  assert.equal(adapter.ids.length,0);assert.deepEqual(calls.find(value=>value.url==='/api/prune/execute').body.selections,['101']);assert.match(get('prune-result-description').textContent,/1 首已读回确认移出/);
});
test('editing a prune condition or changing the destination discards both preview and confirmation',async t=>{
  const {get,context,calls}=await fixture(t,{withPrune:true}),current=()=>vm.runInContext('prune',context);
  get('input-target').value='90001';await get('input-target').fire('input');await get('btn-prune-prepare').click();await until(()=>current().preview&&!current().busy);await get('btn-prune-review').click();
  get('prune-rule').value='artist';await get('prune-rule').fire('change');assert.equal(current().preview,null);assert.equal(current().confirm,null);assert.equal(get('modal-prune-confirm').open,false);
  get('prune-rule').value='live';await get('prune-rule').fire('change');await get('btn-prune-prepare').click();await until(()=>current().preview&&!current().busy);await get('btn-prune-review').click();
  get('input-target').value='90002';await get('input-target').fire('input');assert.equal(current().preview,null);assert.equal(get('modal-prune-confirm').open,false);assert.match(get('prune-error').textContent,/目标歌单已变化/);
  assert.equal(calls.some(value=>value.url==='/api/prune/execute'),false);
});
test('AI pruning shows reasons and uncertainty, never enables unknown suggestions, and leaves original analysis intact',async t=>{
  const adapter=new Demo();adapter.ids=['101','102'];adapter.catalog.set('102',{id:'102',name:'Unknown track',ar:[{name:'Unknown'}],al:{name:'Unknown'}});
  const ai=new MusicAI();ai.configure({key:'fixture-key'});const previous={summary:'Keep original analysis'};ai.lastResult=previous;
  ai.requestJSON=async(_,input)=>({tracks:input.tracks.map((value,i)=>({ref:value.ref,known:i===0,remove:true,confidence:'high',reason:i?'未可靠识别':'这首作品的薄编排符合移除要求'}))});
  const {get,context,document}=await fixture(t,{adapter,ai,demo:false,withPrune:true}),current=()=>vm.runInContext('prune',context);
  get('input-target').value='90001';await get('input-target').fire('input');get('prune-mode').value='ai';await get('prune-mode').fire('change');get('prune-request').value='移除薄编排的歌';await get('prune-request').fire('input');
  await get('btn-prune-prepare').click();await until(()=>current().preview&&!current().busy);
  assert.match(get('prune-candidates').textContent,/薄编排/);assert.match(get('prune-candidates').textContent,/不能删除/);assert.equal(document.querySelectorAll('.prune-check').find(value=>value.dataset.eligible==='false').disabled,true);
  await get('btn-prune-select-all').click();assert.equal(current().selection.size,1);assert.equal(ai.lastResult,previous);assert.equal(ai.job.state,'idle');
});

test('domestic release keeps two platform choices, QR login and pruning while retired authorization routes reject requests', async t => {
  const netease = new Demo(), qq = new Demo({platform:'qq'});
  const {document,get,state,base,app,calls} = await fixture(t,{adapter:netease,adapters:{netease,qq},withPrune:true});
  assert.deepEqual(document.querySelectorAll('#music-platform option').map(value=>value.value),['netease','qq']);
  assert.equal(state().capabilities.prune,true);
  const post = async (route,body={}) => {
    const response = await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Local-Token':app.token},body:JSON.stringify(body)});
    return {status:response.status,body:await response.json()};
  };
  const status = await post('/api/status');assert.deepEqual(status.body.platforms,['netease','qq']);assert.equal(status.body.version,'0.8.2-beta.1');
  for(const platform of ['spotify','apple'])assert.equal((await post('/api/platform',{platform})).status,400);
  for(const route of ['/api/oauth/config','/api/oauth/start','/api/oauth/status','/api/apple/auth-config','/api/apple/user-token'])assert.equal((await post(route)).status,400);
  for(const route of ['/apple-auth.html','/apple-auth.js','/spotify-logo.svg','/oauth/spotify/callback'])assert.equal((await fetch(base+route)).status,403);
  assert.equal((await post('/api/status')).body.platform,'netease');
  get('music-platform').value='qq';await get('music-platform').fire('change');await until(()=>!state().pending&&state().platform==='qq');
  await get('btn-login-modal').click();assert.equal(get('login-tab-qr').classList.contains('hidden'),false);assert.match(get('login-title').textContent,/QQ/);
  assert.equal(calls.some(value=>['/api/import','/api/prune/execute','/api/create'].includes(value.url)),false);
});

test('selected songs and their explicit edition survive a new batch and are matched together without importing', async t => {
  const { document, get, studio, state, calls } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click();
  const original = studio().result.recommendations[0];
  await document.querySelectorAll('.rec-version-button')[0].click();
  const row = studio().recRows.get(0), radios = document.querySelectorAll('.rec-candidate input');
  radios[1].checked = true; await radios[1].fire('change'); await get('btn-confirm-rec-version').click();
  let checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  const originalVersion = row.candidates[1].id;
  await get('btn-new-recommendations').click();
  assert.equal(studio().queue.size, 1); assert.equal(studio().selection.size, 0);
  assert.match(get('btn-match-recommendations').textContent, /1/); assert.equal(get('btn-match-recommendations').disabled, false);
  checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  await get('btn-clear-recommendations').click(); assert.equal(studio().queue.size, 1, 'cancel batch preserves earlier choices');
  checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  await get('btn-open-queue').click(); assert.equal(document.querySelectorAll('.queue-remove').length, 2);
  await get('btn-queue-match').click(); await until(() => !!state().revision && !state().pending);
  assert.equal(state().rows.length, 2); assert.equal(state().choices[0], originalVersion);
  assert.ok(get('input-tracks').value.includes(original.title)); assert.equal(calls.some(call => call.url === '/api/import'), false);
});

test('explicit taste is separate from selection, persists after refresh and is sent only on the next AI action', async t => {
  const storage = new Map(), first = await fixture(t, { withStudio: true, storage });
  await first.get('btn-sample').click(); await first.get('btn-analyze').click();
  const before = JSON.stringify(first.studio().result.axes), requestCount = first.calls.length;
  await first.document.querySelectorAll('.taste-button')[0].click();
  assert.equal(first.studio().feedback[0].mark, 'like'); assert.equal(first.studio().queue.size, 0);
  assert.equal(first.calls.length, requestCount, 'marking a song makes no AI call');
  assert.equal(JSON.stringify(first.studio().result.axes), before);
  assert.equal(first.get('analysis-stale').classList.contains('hidden'), true);
  assert.equal(first.get('recommendation-stale').classList.contains('hidden'), false);
  const refreshed = await fixture(t, { withStudio: true, storage });
  assert.equal(refreshed.studio().feedback.length, 1); assert.equal(refreshed.studio().feedback[0].mark, 'like');
  assert.match(refreshed.get('btn-taste-records').textContent, /1/);
  await first.get('btn-new-recommendations').click();
  assert.equal(first.calls.filter(call => call.url === '/api/ai/recommend').length, 1);
  assert.equal(first.calls.find(call => call.url === '/api/ai/recommend').body.feedback[0].mark, 'like');
  assert.equal(first.get('recommendation-stale').classList.contains('hidden'), true);
});

test('taste can be reversed and cleared with visible confirmation; stored fields never include credentials', async t => {
  const { get, document, studio, storage } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click();
  const checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  await document.querySelectorAll('.taste-button')[1].click();
  assert.equal(studio().queue.size, 0, 'less removes that song from the queue');
  await document.querySelectorAll('.taste-button')[1].click(); assert.equal(studio().feedback.length, 0);
  await document.querySelectorAll('.taste-button')[2].click();
  assert.deepEqual(Object.keys(JSON.parse([...storage.values()][0])[0]).sort(), ['artist','mark','title']);
  const before = studio().result;
  await get('btn-taste-records').click(); await get('btn-clear-taste').click();
  assert.equal(get('taste-clear-confirm').classList.contains('hidden'), false);
  await get('btn-cancel-clear-taste').click(); assert.equal(studio().feedback.length, 1);
  await get('btn-clear-taste').click(); await get('btn-confirm-clear-taste').click();
  assert.equal(studio().feedback.length, 0); assert.equal(storage.size, 0); assert.equal(studio().result, before);
});

test('blocked browser storage keeps feedback usable in memory and states its limitation', async t => {
  const { get, document, studio, calls } = await fixture(t, { withStudio: true, storageBlocked: true });
  await get('btn-sample').click(); await get('btn-analyze').click(); await document.querySelectorAll('.taste-button')[0].click();
  assert.equal(studio().feedback.length, 1); await get('btn-taste-records').click(); assert.match(get('taste-storage-note').textContent, /未能保存/);
  await get('btn-new-recommendations').click(); assert.equal(calls.find(call => call.url === '/api/ai/recommend').body.feedback.length, 1);
});

test('demo taste cannot leak into the real profile, and an empty analysis offers a working input action', async t => {
  const storage = new Map([['playlist-relay-taste-v1-demo', JSON.stringify([{title:'Demo Song',artist:'Artist',mark:'like'}])]]);
  const { get, studio } = await fixture(t, { withStudio: true, storage, demo: false });
  assert.equal(studio().feedback.length, 0); assert.equal(get('btn-analyze-empty').disabled, false);
  assert.equal(get('btn-analyze-empty').textContent, '添加歌曲列表');
  await get('btn-analyze-empty').click(); assert.equal(studio().page, 'playlist');
});

test('an older running backend never silently claims to use the new local taste controls', async t => {
  const ai=new MusicAI({demo:true}), original=ai.status.bind(ai);
  ai.status=()=>{const result=original();delete result.supportsFeedback;return result;};
  const {get,document,studio,calls}=await fixture(t,{withStudio:true,ai});
  await get('btn-sample').click();await get('btn-analyze').click();
  const count=calls.length; await document.querySelectorAll('.taste-button')[0].click();
  assert.equal(studio().feedback.length,0);assert.equal(calls.length,count);
  await get('btn-taste-records').click();assert.match(get('taste-storage-note').textContent,/旧服务.*不支持/);
});

test('frontend token, async matching, candidate selection and confirmed import match backend contracts', async t => {
  const { document, get, state, calls } = await fixture(t);
  assert.equal(state().connected, true); assert.equal(get('btn-login-modal').disabled, true);
  await get('btn-sample').click(); await get('btn-match').click();
  assert.equal(state().rows.length, 3); assert.equal(state().choices.filter(Boolean).length, 3);
  assert.ok(calls.find(call => call.url === '/api/match').body.text.includes('Patti Austin'));
  assert.equal(get('btn-execute-import').disabled, false);
  await document.querySelectorAll('.track-actions button')[0].click();
  const radios = document.querySelectorAll('.candidate-option input');
  radios[1].checked = true; await radios[1].fire('change'); await get('btn-confirm-candidate').click();
  const liveId = state().rows[0].candidates[1].id;
  assert.equal(state().choices[0], liveId);
  await document.querySelectorAll('.skip-btn')[0].click(); assert.equal(state().choices[0], '');
  await document.querySelectorAll('.skip-btn')[0].click(); assert.equal(state().choices[0], liveId);
  await get('btn-execute-import').click(); assert.equal(get('modal-confirm').open, true);
  get('input-target').value = '90002'; await get('input-target').fire('input');
  assert.equal(get('modal-confirm').open, false); assert.equal(state().confirm, null);
  await get('btn-execute-import').click(); await get('btn-confirm-import').click();
  assert.equal(state().report.verified.length, 3); assert.equal(get('result-title').textContent, '模拟导入完成');
  assert.equal(get('result-link').classList.contains('hidden'), true); assert.equal(get('btn-execute-import').disabled, true);
  const requests = calls.filter(call => call.url === '/api/import');
  assert.equal(requests.length, 1); assert.equal(requests[0].body.confirm, true);
  assert.equal(requests[0].body.target, '90002'); assert.equal(requests[0].body.selections[0], liveId);
  await get('btn-confirm-import').click(); assert.equal(calls.filter(call => call.url === '/api/import').length, 1);
});

test('authorization and search failures are visible and never replaced by fake results', async t => {
  const denied = await fixture(t, { badToken: true });
  assert.equal(denied.state().connected, false); assert.equal(denied.state().rows.length, 0);
  assert.equal(denied.get('btn-match').disabled, true); assert.match(denied.get('notice-text').textContent, /完整地址/);
  const adapter = new Demo(); adapter.search = async () => { throw new Error('测试曲库拒绝请求'); };
  const failed = await fixture(t, { adapter });
  await failed.get('btn-sample').click(); await failed.get('btn-match').click();
  assert.equal(failed.state().rows.length, 0); assert.equal(failed.state().revision, '');
  assert.match(failed.get('notice-text').textContent, /测试曲库拒绝请求/); assert.equal(failed.get('btn-execute-import').disabled, true);
});

test('missing rows stay unselected; song metadata is text and changing input invalidates preview', async t => {
  const { document, get, state } = await fixture(t);
  get('input-tracks').value = '<img src=x onerror=alert(1)> — Artist\nmissing song — Artist';
  await get('input-tracks').fire('input'); await get('btn-match').click();
  assert.equal(state().rows.length, 2); assert.equal(state().choices[1], ''); assert.equal(get('stats-missing').textContent, '1 未找到');
  assert.equal(document.nodes().filter(node => node.tagName === 'IMG').length, 0);
  assert.ok(get('track-list').textContent.includes('<img src=x onerror=alert(1)>'));
  get('input-tracks').value = 'different song — Artist'; await get('input-tracks').fire('input');
  assert.equal(state().revision, ''); assert.equal(get('btn-execute-import').disabled, true);
});

test('playlist picker and explicit private creation use actual backend contracts', async t => {
  const { document, get, state, calls } = await fixture(t);
  await get('btn-select-playlist').click(); await until(() => !state().pending);
  await document.querySelectorAll('.playlist-item')[0].click();
  assert.equal(get('input-target').value, '90001'); assert.equal(get('modal-playlists').open, false);
  await get('btn-select-playlist').click(); await until(() => !state().pending);
  get('input-new-playlist').value = '下一份收藏'; await get('btn-create-playlist').click();
  assert.equal(get('input-target').value, '90002');
  const request = calls.find(call => call.url === '/api/create');
  assert.equal(request.body.confirm, true); assert.equal(request.body.privacy, '10'); assert.equal(get('selected-playlist-name').textContent, '下一份收藏');
});

test('studio renders real analysis schema into six axes and song evidence', async t => {
  const { document, get, studio } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-match').click(); await get('btn-go-analysis').click(); await get('btn-analyze').click();
  assert.equal(studio().result.demo, true); assert.equal(studio().result.coverage.total, 3);
  assert.equal(document.querySelectorAll('.axis-button').length, 6); assert.equal(document.querySelectorAll('polygon').length, 6);
  assert.match(get('profile-coverage').textContent, /离线示例/); assert.equal(get('analysis-empty').classList.contains('hidden'), true);
  await document.querySelectorAll('.axis-button')[0].click(); assert.equal(get('modal-evidence').open, true);
  assert.ok(get('evidence-content').textContent.includes('Patti Austin')); assert.match(get('evidence-content').textContent, /演示夹具/);
  get('modal-evidence').close(); get('input-tracks').value = 'different — artist'; await get('input-tracks').fire('input');
  assert.equal(get('analysis-stale').classList.contains('hidden'), false);
});
test('selected AI recommendations become a new real matching plan and still require import confirmation', async t => {
  const { get, studio, state, calls } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click(); await get('btn-profile-discover').click();
  await get('btn-select-recommendations').click(); assert.equal(studio().selection.size, 6);
  await get('btn-match-recommendations').click(); await until(() => !!state().revision && !state().pending);
  assert.equal(studio().page, 'playlist'); assert.equal(state().rows.length, 6);
  assert.ok(calls.find(call => call.url === '/api/match').body.text.includes('Sweet Love — Anita Baker'));
  assert.equal(calls.filter(call => call.url === '/api/import').length, 0);
  await get('btn-execute-import').click(); await get('btn-confirm-import').click();
  assert.equal(state().report.verified.length, 6); assert.equal(calls.filter(call => call.url === '/api/import').length, 1);
});
test('existing playlist metadata can be read and becomes explicit analysis source', async t => {
  const { get, state, studio, calls } = await fixture(t, { withStudio: true });
  await get('btn-read-from-playlist').click(); await until(() => !state().pending);
  assert.equal(studio().playlist.tracks.length, 6); assert.equal(get('analysis-source').value, 'playlist');
  await get('btn-analyze').click();
  assert.equal(studio().result.source.title, '演示歌单'); assert.equal(studio().result.coverage.total, 6);
  const request = calls.find(call => call.url === '/api/ai/analyze'); assert.equal(request.body.tracks.length, 6);
  assert.ok(studio().result.recommendations.every(value => !studio().result.source.tracks.some(track => track.title === value.title && track.artist === value.artist)));
});
test('AI settings keep the key server-side and clear the input immediately', async t => {
  const transport = async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ summary: '测试分析', tracks: [], recommendations: [] }) }, finish_reason: 'stop' }] }));
  const { get, studio, calls } = await fixture(t, { withStudio: true, demo: false, ai: new MusicAI({ transport }) });
  await get('btn-sample').click(); await get('btn-analyze').click(); assert.equal(get('modal-ai-settings').open, true);
  get('input-ai-key').value = 'dummy-test-key'; await get('btn-save-ai-key').click(); await until(() => !studio().settingsBusy);
  assert.equal(get('input-ai-key').value, ''); assert.equal(studio().configured, true);
  assert.equal(JSON.stringify(studio()).includes('dummy-test-key'), false);
  await get('btn-analyze').click(); assert.equal(studio().result.coverage.known, 0);
  assert.equal(calls.find(call => call.url === '/api/ai/analyze').body.key, undefined);
  await get('btn-clear-ai-key').click(); await until(() => !studio().settingsBusy);
  assert.equal(studio().configured, false); assert.equal(studio().result, null);
});

test('loaded playlist identity and counts update; changed target does not silently replace the source', async t => {
  const adapter = new Demo();
  adapter.readPlaylist = async id => ({ id, title: id === '90001' ? 'confused' : '新的歌单', total: 77, sampled: false, tracks: Array.from({ length: 77 }, (_, i) => ({ title: 'Track ' + i, artist: 'Artist' })) });
  const { document, get, state, studio } = await fixture(t, { withStudio: true, adapter });
  await get('btn-read-from-playlist').click(); await until(() => !state().pending);
  assert.equal(get('analysis-source-name').textContent, 'confused');
  assert.equal(get('analysis-source-count').textContent, '77 首');
  assert.equal(get('analysis-playlist-option').textContent, 'confused · 77 首');
  assert.match(get('analysis-source-detail').textContent, /取得 77 首资料.*分析 77 首/);
  await get('btn-source-tracks').click();
  assert.equal(document.querySelectorAll('.source-track').length, 77);
  get('modal-source-tracks').close();
  get('input-target').value = '90002'; await get('input-target').fire('input');
  assert.match(get('analysis-source-warning').textContent, /仍是「confused」/);
  await get('btn-read-playlist').click(); await until(() => !state().pending);
  assert.equal(get('analysis-source-name').textContent, '新的歌单');
  assert.equal(get('analysis-source-warning').classList.contains('hidden'), true);
  await get('btn-analyze').click();
  assert.equal(studio().result.source.tracks.length, 77);
  assert.equal(studio().result.source.total, 77);
});

test('direction changes stay in Discover, keep the loaded source and change recommendations without reanalysis or rereading', async t => {
  const { document, get, studio, calls } = await fixture(t, { withStudio: true });
  await get('btn-read-from-playlist').click(); await get('btn-analyze').click();
  const before = studio().result, source = studio().playlist, axes = JSON.stringify(before.axes);
  await get('btn-profile-discover').click(); get('analysis-direction').value = 'adventurous'; await get('analysis-direction').fire('change');
  assert.equal(get('analysis-direction').closest('#page-analysis'), null);
  assert.equal(get('btn-new-recommendations').disabled, false); assert.equal(get('btn-analyze').disabled, false);
  assert.equal(get('recommendation-stale').classList.contains('hidden'), false);
  await get('btn-new-recommendations').click();
  assert.equal(studio().page, 'discover'); assert.equal(studio().playlist, source);
  assert.equal(JSON.stringify(studio().result.axes), axes); assert.equal(studio().result.summary, before.summary);
  assert.equal(studio().result.direction, 'adventurous'); assert.equal(get('analysis-stale').classList.contains('hidden'), true, 'recommendation settings do not make the analysis stale');
  assert.equal(calls.filter(call => call.url === '/api/playlist/read').length, 1);
  assert.equal(calls.filter(call => call.url === '/api/ai/analyze').length, 1);
  assert.equal(calls.filter(call => call.url === '/api/ai/recommend').length, 1);
  assert.ok(studio().result.recommendations.every(track => !before.recommendations.some(old => old.title === track.title && old.artist === track.artist)));
  await document.querySelectorAll('.axis-button')[3].click();
  assert.match(get('evidence-content').textContent, /加权平均/); assert.match(get('evidence-content').textContent, /器乐 · 3 \/ 5/); assert.match(get('evidence-content').textContent, /独立理由/);
});

test('a failed cover lookup remains visible on its card while the remaining recommendations are queried', async t => {
  const adapter = new Demo(); let coverCalls = 0;
  const search = adapter.search.bind(adapter);
  adapter.search = async row => { coverCalls++; if (coverCalls === 1) throw new Error('单首查询拒绝'); return search(row); };
  const { get, studio, document } = await fixture(t, { withStudio: true, adapter });
  await get('btn-sample').click(); await get('btn-analyze').click(); await get('btn-profile-discover').click();
  await get('btn-load-covers').click();
  assert.equal(coverCalls, studio().result.recommendations.length);
  assert.match(document.querySelectorAll('.rec-error')[0].textContent, /单首查询拒绝/);
  assert.equal(studio().recRows.get(0).candidates.length, 0);
  assert.ok(studio().recRows.get(1).candidates.length);
  assert.equal(get('recommendation-list').textContent.includes('undefined'), false);
});

test('recommendation generation works from a completed snapshot even when the current input is empty', async t => {
  const { get, studio, calls } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click();
  get('input-tracks').value = ''; await get('input-tracks').fire('input');
  await get('btn-profile-discover').click(); get('analysis-direction').value = 'adventurous'; await get('analysis-direction').fire('change');
  assert.equal(get('btn-analyze').textContent, '添加歌曲列表'); assert.equal(get('btn-new-recommendations').disabled, false);
  await get('btn-new-recommendations').click(); assert.equal(studio().result.direction, 'adventurous');
  assert.equal(calls.filter(call => call.url === '/api/playlist/read').length, 0);
});

test('preference editing is only in Discover, does not stale the analysis and sends only recommendation preferences', async t => {
  const { get, document, calls } = await fixture(t,{withStudio:true});
  await get('btn-sample').click(); await get('btn-analyze').click();
  assert.equal(document.querySelectorAll('#analysis-preferences').length,0);
  assert.equal(document.querySelectorAll('#btn-preferences').length,0);
  assert.ok(get('discover-preferences').closest('#page-discover'));
  await get('btn-profile-discover').click(); get('discover-preferences').value='更喜欢器乐交织，避开 lo-fi'; await get('discover-preferences').fire('input');
  assert.equal(get('analysis-stale').classList.contains('hidden'),true);
  await get('btn-new-recommendations').click();
  const analysis = calls.find(call=>call.url==='/api/ai/analyze').body;
  assert.equal(Object.hasOwn(analysis,'preferences'),false);
  assert.equal(calls.find(call=>call.url==='/api/ai/recommend').body.preferences,'更喜欢器乐交织，避开 lo-fi');
  await get('btn-load-covers').click();
  assert.equal(document.querySelectorAll('.favorite-note').length,0);
  assert.equal(get('recommendation-list').textContent.includes('收藏优先'),false);
  assert.match(get('recommendation-count').textContent,/^本批 \d+ 首/);
});

test('a repeated recommendation response explains the rejection and leaves only one error with an enabled retry', async t => {
  let calls = 0;
  const ai = new MusicAI({transport:async()=>{
    calls++;
    return new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify({tracks:[],recommendations:[{title:'Fresh Song',artist:'Artist',reason:'reason',refs:['t1']}]})}}]}));
  }});
  ai.configure({key:'private-key'});
  const {get,studio,document} = await fixture(t,{withStudio:true,demo:false,ai});
  await get('btn-sample').click(); await get('btn-analyze').click();
  const before=studio().result;
  const selected = document.querySelectorAll('.recommendation-card input')[0]; selected.checked = true; await selected.fire('change');
  await get('btn-profile-discover').click(); get('analysis-direction').value='adventurous'; await get('analysis-direction').fire('change');
  await get('btn-new-recommendations').click();
  assert.match(get('discover-error').textContent,/AI 返回 1.*重复.*当前仍显示上一批/);
  assert.equal(get('recommendation-stale').classList.contains('hidden'),true);
  assert.equal(studio().result,before); assert.equal(get('btn-new-recommendations').disabled,false); assert.equal(get('btn-new-recommendations').textContent,'再生成一次');
  assert.equal(studio().queue.size,1); assert.equal(get('btn-match-recommendations').disabled,false);
  await get('btn-new-recommendations').click(); assert.equal(calls,3);
  get('discover-preferences').value='换些不同歌手'; await get('discover-preferences').fire('input');
  assert.equal(get('discover-error').classList.contains('hidden'),true);
});

test('album version selection uses validated cover metadata and survives the new matching plan without writing', async t => {
  const adapter = new Demo();
  const search = adapter.search.bind(adapter);
  adapter.search = async row => (await search(row)).map((value, index) => ({ ...value, al: { ...value.al, picUrl: index ? 'https://untrusted.example/cover.png' : 'http://p1.music.126.net/album-test.png' } }));
  const { document, get, state, studio, calls } = await fixture(t, { withStudio: true, adapter });
  await get('btn-sample').click(); await get('btn-analyze').click(); await get('btn-profile-discover').click();
  await document.querySelectorAll('.rec-version-button')[0].click();
  assert.equal(get('modal-rec-versions').open, true);
  const row = studio().recRows.get(0);
  assert.equal(row.candidates[0].cover, 'https://p1.music.126.net/album-test.png');
  assert.equal(row.candidates[1].cover, '');
  assert.equal(document.querySelectorAll('.candidate-cover').length, 1);
  const radios = document.querySelectorAll('.rec-candidate input');
  radios[1].checked = true; await radios[1].fire('change'); await get('btn-confirm-rec-version').click();
  assert.equal(studio().recChoices.get(0), row.candidates[1].id);
  assert.match(document.querySelectorAll('.rec-album')[0].textContent, /现场版/);
  const checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  await get('btn-match-recommendations').click(); await until(() => !!state().revision && !state().pending);
  assert.equal(state().choices[0], row.candidates[1].id);
  assert.equal(calls.some(value => value.url === '/api/import'), false);
});

test('an append marks the loaded source stale until explicitly read again', async t => {
  const { get, state, studio } = await fixture(t, { withStudio: true });
  await get('btn-read-from-playlist').click(); await get('btn-sample').click(); await get('btn-match').click();
  await get('btn-execute-import').click(); await get('btn-confirm-import').click();
  assert.equal(studio().playlist.needsRefresh, true);
  assert.match(get('analysis-source-warning').textContent, /追加前/);
  await get('btn-read-playlist').click(); await until(() => !state().pending);
  assert.equal(get('analysis-source-warning').classList.contains('hidden'), true);
});

test('AI settings expose four providers, isolate keys and reject unconfirmed billing', async t => {
  const { get, studio, calls } = await fixture(t, { withStudio: true, demo: false });
  await get('btn-ai-settings').click();
  assert.equal(get('ai-provider').children.length, 4);
  get('input-ai-key').value = 'dummy-zhipu'; await get('btn-save-ai-key').click();
  await get('btn-ai-settings').click();
  get('ai-provider').value = 'deepseek'; await get('ai-provider').fire('change');
  assert.equal(get('ai-model').value, 'deepseek-flash');
  assert.equal(get('input-ai-key').value, '');
  assert.match(get('ai-key-status').textContent, /尚未配置/);
  assert.equal(get('ai-cost-zone').classList.contains('hidden'), false);
  get('input-ai-key').value = 'dummy-deepseek'; await get('btn-save-ai-key').click();
  assert.match(get('ai-settings-error').textContent, /费用/);
  assert.equal(studio().provider, 'zhipu');
  get('ai-confirm-cost').checked = true; get('input-ai-key').value = 'dummy-deepseek'; await get('btn-save-ai-key').click();
  assert.equal(studio().provider, 'deepseek'); assert.equal(get('input-ai-key').value, '');
  assert.equal(JSON.stringify(studio()).includes('dummy-'), false);
  assert.equal(calls.some(value => value.url === '/api/ai/analyze'), false);
});

test('switching music platform clears old plans, analysis source and results; stale tabs cannot issue operations', async t => {
  const adapter = new Demo(), qq = new Demo({ platform: 'qq' });
  const { get, state, studio, app, base } = await fixture(t, { withStudio: true, adapter, adapters: { netease: adapter, qq } });
  await get('btn-read-from-playlist').click(); await get('btn-sample').click(); await get('btn-match').click(); await get('btn-analyze').click();
  assert.ok(state().revision); assert.ok(studio().result); assert.ok(studio().playlist);
  get('music-platform').value = 'qq'; await get('music-platform').fire('change'); await until(() => state().platform === 'qq' && !state().pending);
  assert.equal(state().revision, ''); assert.equal(state().rows.length, 0); assert.equal(studio().playlist, null); assert.equal(studio().result, null);
  assert.equal(get('btn-generate-qr').disabled, true); assert.equal(get('login-tab-qr').classList.contains('hidden'), false); assert.equal(get('qq-qr-types').classList.contains('hidden'), false);
  assert.match(get('create-privacy-note').textContent, /私密/); assert.equal(get('input-privacy').value, '10'); assert.equal(get('btn-create-playlist').disabled, true);
  get('input-privacy').value = '0'; await get('input-privacy').fire('change'); assert.equal(get('btn-create-playlist').disabled, false);
  const stale = await fetch(base + '/api/match', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': app.token }, body: JSON.stringify({ expectedPlatform: 'netease', text: 'So Sick — Ne-Yo', target: '90001' }) });
  assert.equal(stale.status, 400); assert.match((await stale.json()).error, /平台/);
});

test('favorite-selected edition reaches matching; a manual choice is labeled as manual and lookup never imports', async t => {
  const adapter = new Demo({ platform: 'qq' }), search = adapter.search.bind(adapter);
  adapter.search = async row => { const songs = await search(row); return [songs[0], { ...songs[0], id: String(Number(songs[0].id) + 123), al: { name: 'Other edition', picUrl: 'https://y.gtimg.cn/music/photo_new/album.jpg' } }, songs[1]]; };
  adapter.favoriteCounts = async ids => Object.fromEntries(ids.map((id, index) => [id, index === 1 ? 100 : index === 2 ? 999 : 1]));
  const { get, document, state, studio, calls } = await fixture(t, { adapter, withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click(); await document.querySelectorAll('.rec-version-button')[0].click();
  const row = studio().recRows.get(0); assert.equal(studio().recChoices.get(0), row.candidates[1].id);
  const radios = document.querySelectorAll('.rec-candidate input'); radios[2].checked = true; await radios[2].fire('change'); await get('btn-confirm-rec-version').click();
  assert.match(document.querySelectorAll('.cover-note')[0].textContent, /已选版本/);
  assert.equal(document.querySelectorAll('.favorite-note').length, 0);
  const checkbox = document.querySelectorAll('.recommendation-card input')[0]; checkbox.checked = true; await checkbox.fire('change');
  await get('btn-match-recommendations').click(); await until(() => !!state().revision && !state().pending);
  assert.equal(state().choices[0], row.candidates[2].id); assert.equal(calls.some(value => value.url === '/api/import'), false);
});

test('music platform changes preserve separately configured AI keys', async t => {
  const adapter = new Demo(), ai = new MusicAI();
  const { get, state, studio } = await fixture(t, { demo: false, withStudio: true, adapter, ai, adapters: { netease: adapter, qq: new Demo({ platform: 'qq' }) } });
  await get('btn-ai-settings').click(); get('input-ai-key').value = 'local-dummy'; await get('btn-save-ai-key').click(); assert.equal(studio().configured, true);
  get('music-platform').value = 'qq'; await get('music-platform').fire('change'); await until(() => state().platform === 'qq' && !state().pending);
  assert.equal(studio().configured, true); assert.equal(get('input-ai-key').value, ''); assert.equal(studio().result, null);
});

test('first analysis actions lead to input then AI setup, without submitting a model request', async t => {
  const { get, studio, calls } = await fixture(t, { withStudio: true, demo: false });
  await get('btn-go-analysis').click(); assert.equal(studio().page, 'analysis');
  assert.equal(get('btn-analyze').textContent, '添加歌曲列表');
  await get('btn-analyze-empty').click(); assert.equal(studio().page, 'playlist');
  assert.equal(get('modal-ai-settings').open, false);
  await get('btn-sample').click(); await get('btn-go-analysis').click();
  assert.equal(get('btn-analyze').textContent, '配置 AI');
  assert.match(get('analysis-empty-description').textContent, /3 行已准备/);
  await get('btn-analyze').click(); assert.equal(get('modal-ai-settings').open, true);
  assert.equal(calls.some(call => ['/api/ai/analyze', '/api/ai/config'].includes(call.url)), false);
});

test('a changed source labels the previous analysis before the chart, while recommendation changes leave it current', async t => {
  const { get, studio } = await fixture(t, { withStudio: true });
  await get('btn-sample').click(); await get('btn-analyze').click();
  const original = studio().result;
  get('analysis-direction').value = 'adventurous'; await get('analysis-direction').fire('change');
  assert.equal(get('analysis-stale').classList.contains('hidden'), true);
  get('input-tracks').value = 'Another Song — Another Artist'; await get('input-tracks').fire('input');
  assert.equal(studio().result, original);
  assert.equal(get('analysis-stale').parent, get('analysis-report'));
  assert.equal(get('analysis-stale').classList.contains('hidden'), false);
  assert.match(get('analysis-stale').textContent, /当前展示「当前歌曲」.*重新分析后更新/);
});

test('QQ album covers render after matching and untrusted image hosts are still excluded', async t => {
  const adapter = new Demo({ platform: 'qq' }), search = adapter.search.bind(adapter);
  adapter.search = async row => (await search(row)).map(value => ({ ...value, al: { ...value.al, picUrl: row.title === 'Trusted Song' ? 'https://y.gtimg.cn/music/photo_new/T002R300x300M000fixture.jpg' : 'https://untrusted.example/image.jpg' } }));
  const { get, document, state, calls } = await fixture(t, { adapter, withStudio: true });
  get('input-tracks').value = 'Trusted Song — Artist\nOther Song — Artist'; await get('input-tracks').fire('input');
  await get('btn-match').click(); await until(() => state().rows.length === 2 && !state().pending);
  const covers = document.querySelectorAll('.track-cover').filter(node => node.tagName === 'IMG');
  assert.equal(covers.length, 1); assert.match(covers[0].src, /^https:\/\/y\.gtimg\.cn\/music\/photo_new\//);
  assert.equal(calls.some(call => call.url === '/api/import'), false);
});

test('choosing a playlist when logged out opens QR and resumes the picker after phone confirmation', async t => {
  const adapter = new Demo({ platform: 'qq' }); let logged = false;
  adapter.user = async () => { if (!logged) throw new Error('not logged in'); return { id: '123', name: 'Local fixture' }; };
  adapter.qr = async () => ({ image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 180000 });
  adapter.qrCheck = async () => { logged = true; return { code: 803, authorized: true, user: await adapter.user() }; };
  const { get, state, calls } = await fixture(t, { adapter, withStudio: true, demo: false, qrPollDelay: 30 });
  assert.equal(get('btn-select-playlist').disabled, false); assert.equal(get('btn-source-picker').disabled, false);
  await get('btn-source-picker').click(); await until(() => get('modal-playlists').open && !state().pending);
  assert.equal(get('modal-login').open, false); assert.equal(state().loginIntent, '');
  assert.equal(calls.filter(call => call.url === '/api/playlists').length, 1);
  assert.equal(calls.some(call => ['/api/import','/api/create','/api/ai/analyze'].includes(call.url)), false);
});

test('canceling playlist login removes the continuation rather than opening a picker on a later login', async t => {
  const adapter = new Demo({ platform: 'qq' });
  adapter.user = async () => { throw new Error('not logged in'); };
  adapter.qr = async () => ({ image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 180000 });
  const { get, state, context, calls } = await fixture(t, { adapter, demo: false });
  await get('btn-select-playlist').click(); await until(() => state().qrReady && !state().pending);
  get('modal-login').close(); await until(() => state().loginIntent === '');
  state().user = { id: '123', name: 'Fixture' }; vm.runInContext('sync()', context);
  assert.equal(get('modal-playlists').open, false); assert.equal(calls.some(call => call.url === '/api/playlists'), false);
});

test('QQ login defaults to QR, detects confirmation automatically and never requires a Cookie or import', async t => {
  const adapter = new Demo({ platform: 'qq' }); let logged = false;
  adapter.user = async () => { if (!logged) throw new Error('not logged in'); return { id: '123', name: 'Local fixture' }; };
  adapter.qr = async type => ({ type, image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 180000 });
  adapter.qrCheck = async () => { logged = true; return { code: 803, authorized: true, user: await adapter.user() }; };
  const { get, state, calls } = await fixture(t, { adapter, demo: false, qrPollDelay: 30 });
  await get('btn-login-modal').click(); await until(() => !state().pending && state().qrReady);
  assert.equal(get('login-tab-cookie').classList.contains('hidden'), true); assert.match(get('qr-status').textContent, /手机 QQ/);
  await until(() => !!state().user && !state().pending);
  assert.equal(get('modal-login').open, false); assert.equal(state().session.source, 'qr');
  assert.equal(calls.filter(value => value.url === '/api/qr/check').length, 1);
  assert.equal(calls.some(value => ['/api/cookie','/api/import'].includes(value.url)), false);
});

test('QQ/WX mode can change during status polling; the old check is canceled and its late result ignored', async t => {
  const adapter = new Demo({ platform: 'qq' }); let mode = 'qq', release, canceled = 0;
  adapter.user = async () => { throw new Error('not logged in'); };
  adapter.qr = async type => { mode = type; return { type, image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 180000 }; };
  adapter.qrCheck = async () => mode === 'qq' ? new Promise(resolve => { release = resolve; }) : { code: 801 };
  adapter.qrCancel = () => { canceled++; if (release) { const resolve = release; release = null; resolve({ code: 803, authorized: true, user: { id: '999', name: 'Must be ignored' } }); } };
  const { get, state, calls } = await fixture(t, { adapter, demo: false, qrPollDelay: 30 });
  await get('btn-login-modal').click(); await until(() => !!release);
  assert.equal(get('btn-qr-wx').disabled, false);
  await get('btn-qr-wx').click(); await until(() => !state().pending && state().qrReady);
  assert.equal(state().user, null); assert.equal(state().qqQrType, 'wx'); assert.match(get('qr-status').textContent, /微信/);
  assert.equal(calls.filter(value => value.url === '/api/qr').at(-1).body.type, 'wx'); assert.ok(canceled);
  get('modal-login').close(); await until(() => !state().qrReady);
});

test('QQ phone authorization followed by profile failure keeps a verifiable session and stops automatic polling', async t => {
  const adapter = new Demo({ platform: 'qq' }); let verified = false;
  adapter.user = async () => { if (!verified) throw new Error('profile unavailable'); return { id: '123', name: 'Local fixture' }; };
  adapter.qr = async () => ({ image: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: Date.now() + 180000 });
  adapter.qrCheck = async () => ({ code: 803, authorized: true, user: null, warning: '测试：账号资料暂不可用，已保留会话。' });
  const { get, state, calls } = await fixture(t, { adapter, demo: false, qrPollDelay: 30 });
  await get('btn-login-modal').click(); await until(() => state().session.hasSession && !state().pending).catch(error => { throw new Error(JSON.stringify({ platform: state().platform, pending: state().pending, qrReady: state().qrReady, qrStatus: get('qr-status').textContent, loginError: get('login-error').textContent, calls: calls.map(value => value.url) }), { cause: error }); });
  assert.equal(state().qrReady, false); assert.equal(get('modal-login').open, true); assert.equal(get('btn-verify-session').disabled, false);
  assert.match(get('login-error').textContent, /已保留会话/);
  verified = true; await get('btn-verify-session').click(); assert.equal(state().user.id, '123');
  assert.equal(calls.filter(value => value.url === '/api/qr/check').length, 1);
});
