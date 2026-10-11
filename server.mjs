import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseList, rank, playlistId, selectedIds, appendVerified, withFavoritePreference } from './core.mjs';
import { QQMusic } from './qq.mjs';
import { MusicAI } from './ai.mjs';
import { PlaylistPruner } from './prune.mjs';

export function createApp(api, { demo = false, ai = new MusicAI({ demo }), adapters } = {}) {
  const platforms = adapters || { [api.platform || 'netease']: api };
  let platform = api.platform || 'netease';
  if (!platforms[platform]) platform = Object.keys(platforms)[0];
  const platformInfo = () => ({ platform, platforms: Object.keys(platforms), capabilities: { ...(api.capabilities?.() || { qr: true, create: true, privateCreate: true, favorites: false }), prune:['netease','qq'].includes(platform)&&typeof api.readForPrune==='function'&&typeof api.remove==='function' } });
  const token = randomBytes(32).toString('hex');
  const pruner = new PlaylistPruner(ai);
  let plan = null, busy = false, report = null, job = null, analysisSource = null;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.music.126.net https://y.gtimg.cn; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const send = (res, status, data) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '只允许本机页面访问' });
    const url = new URL(req.url, origin);
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/studio.js': ['studio.js', 'text/javascript'], '/prune.js': ['prune.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      const content = await readFile(new URL('./public/' + file, import.meta.url));
      res.writeHead(200, { ...headers, 'Content-Type': type + '; charset=utf-8' }); return res.end(content);
    }
    if (req.method !== 'POST' || req.headers['x-local-token'] !== token || !String(req.headers['content-type']).startsWith('application/json')) return send(res, 403, { error: '请用启动窗口提供的完整地址打开' });
    let chunks = [], size = 0, ownsLock = false;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 400000) throw new Error('请求过大'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (data.expectedPlatform && !['/api/status', '/api/platform'].includes(url.pathname) && data.expectedPlatform !== platform) throw new Error('音乐平台已在另一页面切换，请刷新后重新核对。');
      if (url.pathname === '/api/prune/job') return send(res,200,pruner.job);
      if (url.pathname === '/api/prune/cancel') { pruner.cancel(); return send(res,200,{ok:true}); }
      if (url.pathname === '/api/prune/backup') {
        const p=pruner.plan;if(!p||p.revision!==data.revision)throw new Error('整理预览已失效，请重新筛选。');
        return send(res,200,{platform:p.platform,playlistId:p.pid,playlistName:p.snapshot.name,time:new Date(p.created).toISOString(),tracks:p.tracks});
      }
      if (['preparing','checking','removing'].includes(pruner.job.state) && ['/api/ai/analyze','/api/ai/recommend','/api/ai/config'].includes(url.pathname)) throw new Error('歌单整理任务正在执行，请先等待或取消筛选。');
      if (url.pathname === '/api/job') return send(res, 200, job || { state: 'idle' });
      if (url.pathname === '/api/report') return send(res, 200, report || {});
      if (url.pathname === '/api/ai/status') return send(res, 200, ai.status());
      if (url.pathname === '/api/analysis/source') return send(res, 200, { source: analysisSource });
      if (url.pathname === '/api/qr/cancel') { api.qrCancel?.(); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/ai/job') return send(res, 200, ai.job);
      if (url.pathname === '/api/ai/config') return send(res, 200, ai.configure(data));
      if (url.pathname === '/api/ai/analyze') return send(res, 202, ai.start({ ...data, tracks: data.tracks || parseList(data.text, data.order) }));
      if (url.pathname === '/api/ai/recommend') return send(res, 202, ai.startRecommendations(data));
      if (url.pathname === '/api/ai/cancel') { ai.cancel(true); return send(res, 200, { ok: true }); }
      if (busy) return send(res, 409, { error: '正在处理，请等待当前任务结束。' });
      busy = true;
      ownsLock = true;
      let output;
      switch (url.pathname) {
        case '/api/status': output = { ...platformInfo(), version:'0.8.2-beta.1', demo, user: await api.user().catch(() => null), session: api.sessionInfo?.() || {}, ai: ai.status() }; break;
        case '/api/platform': {
          if (!Object.hasOwn(platforms, data.platform)) throw new Error('当前服务未启用此音乐平台。');
          api.qrCancel?.(); pruner.clear(); platform = data.platform; api = platforms[platform]; plan = null; report = null; job = null; analysisSource = null; ai.cancel();
          output = { ...platformInfo(), demo, user: await api.user().catch(() => null), session: api.sessionInfo?.() || {} }; break;
        }
        case '/api/cookie': plan = null; pruner.clear(); output = { user: await api.setCookie(data.cookie) }; analysisSource = null; break;
        case '/api/qr': output = await api.qr(data.type); break;
        case '/api/qr/check': output = await api.qrCheck(); if (output.authorized || output.user) { plan = null; pruner.clear(); analysisSource = null; } break;
        case '/api/session/verify': output = { user: await api.user(), session: api.sessionInfo?.() || {} }; plan = null; break;
        case '/api/clear': api.clear(); pruner.clear(); plan = null; report = null; job = null; analysisSource = null; output = { ok: true }; break;
        case '/api/playlists': output = { playlists: await api.playlists((await api.user()).id) }; break;
        case '/api/playlist/read': output = { ...await api.readPlaylist(playlistId(data.target, platform)), platform }; analysisSource = output; break;
        case '/api/prune/prepare': {
          const pid=playlistId(data.target,platform), adapter=api;
          // The lock spans complete reads and optional model batches. No writes here.
          const task=pruner.prepare(adapter,pid,data);
          task.catch(error=>{pruner.job={state:'error',error:error.message};}).finally(()=>{busy=false;});
          ownsLock=false;return send(res,202,{started:true});
        }
        case '/api/prune/execute': {
          if(data.confirm!==true)throw new Error('请明确确认待删歌曲与目标歌单。');
          pruner.select(data.revision,data.selections);
          const adapter=api,pid=pruner.plan.pid;
          plan=null;pruner.job={state:'checking',progress:{done:0,total:data.selections.length}};
          if(analysisSource&&String(analysisSource.id)===pid)analysisSource.needsRefresh=true;
          pruner.execute(adapter,data.revision,data.selections,data.confirm).catch(error=>{pruner.plan=null;pruner.job={state:'error',error:error.message};}).finally(()=>{busy=false;});
          ownsLock=false;return send(res,202,{started:true});
        }
        case '/api/recommendation/search': {
          const rows = parseList(String(data.title || '') + ' — ' + String(data.artist || ''));
          if (rows.length !== 1 || !rows[0].artist) throw new Error('推荐查询需要一个歌名和歌手。');
          output = rank(rows[0], await api.search(rows[0]));
          let counts = {}; if (api.favoriteCounts && output.candidates.length) { try { counts = await api.favoriteCounts(output.candidates.map(value => value.id)); } catch { output.favoriteWarning = '收藏人数查询失败，未自动重试。'; } }
          output = withFavoritePreference(output, counts); output.favoriteDemo = demo; break;
        }
        case '/api/create': {
          if (data.confirm !== true) throw new Error('需要明确确认创建歌单');
          await api.user();
          output = await api.create(data.name, data.privacy); plan = plan && { ...plan, target: output.id };
          break;
        }
        case '/api/match': {
          const rows = parseList(data.text, data.order); plan = null; report = null;
          api.resetSearchTypes?.();
          const target = data.target ? playlistId(data.target, platform) : '';
          const revision = randomBytes(12).toString('hex');
          job = { state: 'matching', done: 0, total: rows.length, rows: [] };
          (async () => {
            try {
              for (const row of rows) { job.rows.push(rank(row, await api.search(row))); job.done++; }
              plan = { revision, target, rows: job.rows, created: Date.now() };
              job = { ...job, state: 'matched', revision };
            } catch (e) { job = { ...job, state: 'error', error: e.message }; }
            finally { busy = false; }
          })();
          return send(res, 202, { started: true });
        }
        case '/api/import': {
          if (data.confirm !== true) throw new Error('请先确认候选歌曲和目标歌单。');
          if (!plan || data.revision !== plan.revision || Date.now() - plan.created > 1800000) throw new Error('预览已失效，请重新匹配。');
          const pid = playlistId(data.target, platform);
          const ids = selectedIds(plan.rows, data.selections);
          const user = await api.user();
          // Verify ownership before dispatch; recheck in appendVerified as well.
          const p = await api.detail(pid);
          if (String(p.creator?.userId) !== user.id) throw new Error('该歌单不属于当前账号。');
          job = { state: 'importing', done: 0, total: ids.length };
          if (analysisSource && String(analysisSource.id) === pid) analysisSource.needsRefresh = true;
          plan = null; report = null;
          (async () => {
            try {
              report = await appendVerified(api, pid, user.id, ids, (done, total) => { job.done = done; job.total = total; });
              job = { state: 'imported', report, demo };
            } catch (e) { job = { state: 'error', error: e.message }; }
            finally { busy = false; }
          })();
          return send(res, 202, { started: true });
        }
        default: throw new Error('未知操作');
      }
      send(res, 200, output);
    } catch (e) { send(res, 400, { error: e.message }); }
    finally { if (ownsLock && !['matching', 'importing'].includes(job?.state)) busy = false; }
  });
  server.on('close', () => { pruner.clear(); ai.clear(); Object.values(platforms).forEach(value => value.clear?.()); });
  return { server, token };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const { [demo ? 'Demo' : 'Netease']: Adapter } = await import(demo ? './demo.mjs' : './netease.mjs');
  const main = new Adapter();
  const app = createApp(main, { demo, adapters: { netease: main, qq: demo ? new Adapter({ platform: 'qq' }) : new QQMusic() } });
  app.server.listen(Number(process.env.PORT || 8765), '127.0.0.1', () => console.log(`\n本地歌单助手${demo ? '【离线演示】' : ''}\n请打开：http://127.0.0.1:${app.server.address().port}/#${app.token}\n关闭此窗口会清除本工具内存中的登录信息。\n`));
  app.server.on('error', () => { console.error('启动失败，端口可能被占用。请换一个 PORT。'); process.exitCode = 1; });
}
