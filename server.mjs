import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { parseList, rank, playlistId, selectedIds, appendVerified, withFavoritePreference, assertWritable } from './core.mjs';
import { QQMusic } from './qq.mjs';
import { Spotify, AppleMusic } from './global-music.mjs';
import { appleTokenFromEnvironment } from './apple-token.mjs';
import { MusicAI } from './ai.mjs';

export function createApp(api, { demo = false, ai = new MusicAI({ demo }), adapters } = {}) {
  const platforms = adapters || { [api.platform || 'netease']: api };
  let platform = api.platform || 'netease';
  if (!platforms[platform]) platform = Object.keys(platforms)[0];
  const platformInfo = () => ({ platform, platforms: Object.keys(platforms), capabilities: api.capabilities?.() || { qr: true, create: true, privateCreate: true, favorites: false } });
  const token = randomBytes(32).toString('hex');
  let plan = null, busy = false, report = null, job = null, analysisSource = null;
  const headers = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: https://*.music.126.net https://y.gtimg.cn https://i.scdn.co https://is1-ssl.mzstatic.com https://is2-ssl.mzstatic.com https://is3-ssl.mzstatic.com https://is4-ssl.mzstatic.com https://is5-ssl.mzstatic.com https://is6-ssl.mzstatic.com https://is7-ssl.mzstatic.com https://is8-ssl.mzstatic.com https://is9-ssl.mzstatic.com; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
  const send = (res, status, data) => { res.writeHead(status, { ...headers, 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
  const server = http.createServer(async (req, res) => {
    const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
    const url = new URL(req.url, origin);
    const spotifyCallback = req.method === 'GET' && url.pathname === '/oauth/spotify/callback';
    if (req.headers.host !== host || (req.headers.origin && req.headers.origin !== origin) || !spotifyCallback && ['cross-site', 'same-site'].includes(req.headers['sec-fetch-site'])) return send(res, 403, { error: '只允许本机页面访问' });
    if (spotifyCallback) {
      let success=false,locked=false,reason='';
      try { if(platform!=='spotify'||busy)throw new Error('当前平台已切换或任务正在执行，请完成当前任务后重新授权。');busy=true;locked=true;await api.finishAuth({state:url.searchParams.get('state'),code:url.searchParams.get('code'),error:url.searchParams.get('error')});plan=null;analysisSource=null;success=true; } catch(e) { reason=String(e.message||'授权未完成').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); } finally {if(locked)busy=false;}
      res.writeHead(success?200:400,{...headers,'Content-Type':'text/html; charset=utf-8'});
      return res.end(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"><title>Spotify 授权结果</title><main class="oauth-page"><h1>${success?'Spotify 已连接':'Spotify 授权未完成'}</h1><p>${success?'返回原来的歌单接力标签页，在登录窗口点击“检查连接”，再选择歌单。':reason}</p>${success?'':'<p>请核对回调地址、Premium、测试用户名单和歌单权限。不会显示或记录授权码。</p>'}<p>可以关闭此页，回到原来的歌单接力标签页。</p></main></html>`);
    }
    const assets = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/studio.js': ['studio.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/apple-auth.html':['apple-auth.html','text/html'], '/apple-auth.js':['apple-auth.js','text/javascript'], '/spotify-logo.svg':['spotify-logo.svg','image/svg+xml'] };
    if (req.method === 'GET' && assets[url.pathname]) {
      const [file, type] = assets[url.pathname];
      const content = await readFile(new URL('./public/' + file, import.meta.url));
      const authHeaders = url.pathname === '/apple-auth.html' ? { 'Content-Security-Policy': "default-src 'none'; script-src 'self' https://js-cdn.music.apple.com; style-src 'self'; connect-src 'self' https://api.music.apple.com https://*.music.apple.com; img-src 'self' data: https://*.mzstatic.com; frame-src https://*.music.apple.com https://appleid.apple.com https://idmsa.apple.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } : {};
      res.writeHead(200, { ...headers, ...authHeaders, 'Content-Type': type + '; charset=utf-8' }); return res.end(content);
    }
    if (req.method !== 'POST' || req.headers['x-local-token'] !== token || !String(req.headers['content-type']).startsWith('application/json')) return send(res, 403, { error: '请用启动窗口提供的完整地址打开' });
    let chunks = [], size = 0, ownsLock = false;
    try {
      for await (const chunk of req) { size += chunk.length; if (size > 400000) throw new Error('请求过大'); chunks.push(chunk); }
      const data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
      if (data.expectedPlatform && !['/api/status', '/api/platform'].includes(url.pathname) && data.expectedPlatform !== platform) throw new Error('音乐平台已在另一页面切换，请刷新后重新核对。');
      if (url.pathname === '/api/job') return send(res, 200, job || { state: 'idle' });
      if (url.pathname === '/api/report') return send(res, 200, report || {});
      if (url.pathname === '/api/ai/status') return send(res, 200, ai.status());
      if (url.pathname === '/api/analysis/source') return send(res, 200, { source: analysisSource });
      if (url.pathname === '/api/qr/cancel') { api.qrCancel?.(); return send(res, 200, { ok: true }); }
      if (url.pathname === '/api/ai/job') return send(res, 200, ai.job);
      if (url.pathname === '/api/ai/config') return send(res, 200, ai.configure(data));
      if (url.pathname === '/api/ai/analyze' || url.pathname === '/api/ai/recommend') {
        if (api.capabilities?.().aiAnalysis === false || data.tracks?.some?.(value=>value.sourcePlatform==='spotify'||value.platform==='spotify')) throw new Error('Spotify 平台内容不能用于 AI 分析或画像。此平台仅提供歌曲匹配与歌单导入。');
        return send(res, 202, url.pathname === '/api/ai/analyze' ? ai.start({ ...data, tracks: data.tracks || parseList(data.text, data.order) }) : ai.startRecommendations(data));
      }
      if (url.pathname === '/api/apple/auth-config') { if(platform!=='apple')throw new Error('当前未选择 Apple Music。');return send(res,200,api.authConfig(data.nonce)); }
      if (url.pathname === '/api/ai/cancel') { ai.cancel(true); return send(res, 200, { ok: true }); }
      if (busy) return send(res, 409, { error: '正在处理，请等待当前任务结束。' });
      busy = true;
      ownsLock = true;
      let output;
      switch (url.pathname) {
        case '/api/status': output = { ...platformInfo(), version:'0.7.0-beta', demo, user: await api.user().catch(() => null), session: api.sessionInfo?.() || {}, ai: ai.status() }; break;
        case '/api/platform': {
          if (!Object.hasOwn(platforms, data.platform)) throw new Error('当前服务未启用此音乐平台。');
          api.qrCancel?.(); api.cancelAuth?.(); platform = data.platform; api = platforms[platform]; plan = null; report = null; job = null; analysisSource = null; ai.cancel();
          output = { ...platformInfo(), demo, user: await api.user().catch(() => null), session: api.sessionInfo?.() || {} }; break;
        }
        case '/api/cookie': plan = null; output = { user: await api.setCookie(data.cookie) }; analysisSource = null; break;
        case '/api/oauth/config': {
          if(!api.configure||!api.capabilities?.().oauth||demo)throw new Error('当前平台不使用此授权配置。');
          output={session:await api.configure({...data,origin}),redirectUri:platform==='spotify'?origin+'/oauth/spotify/callback':''};plan=null;analysisSource=null;break;
        }
        case '/api/oauth/start': {
          if(!api.beginAuth||demo)throw new Error('当前平台不使用网页授权。');
          const started=api.beginAuth(origin+'/oauth/spotify/callback');
          output=platform==='apple'?{authorizeUrl:origin+'/apple-auth.html#'+token+':'+started.nonce}:started;plan=null;analysisSource=null;break;
        }
        case '/api/apple/user-token': {
          if(platform!=='apple'||demo)throw new Error('当前未选择 Apple Music。');output={user:await api.finishAuth(data.nonce,data.userToken),session:api.sessionInfo()};plan=null;analysisSource=null;break;
        }
        case '/api/qr': output = await api.qr(data.type); break;
        case '/api/qr/check': output = await api.qrCheck(); if (output.authorized || output.user) { plan = null; analysisSource = null; } break;
        case '/api/session/verify': if(api.sessionInfo?.().authPending)throw new Error('官方授权尚未完成，请完成授权后再检查连接。');output = { user: await (api.verifySession?.() || api.user()), session: api.sessionInfo?.() || {} }; plan = null; break;
        case '/api/clear': api.clear(); plan = null; report = null; job = null; analysisSource = null; output = { ok: true }; break;
        case '/api/playlists': output = { playlists: await api.playlists((await api.user()).id) }; break;
        case '/api/playlist/read': output = { ...await api.readPlaylist(playlistId(data.target, platform)), platform }; analysisSource = output; break;
        case '/api/recommendation/search': {
          const rows = parseList(String(data.title || '') + ' — ' + String(data.artist || ''));
          if (rows.length !== 1 || !rows[0].artist) throw new Error('推荐查询需要一个歌名和歌手。');
          output = rank(rows[0], await api.search(rows[0]));
          let counts = {}; if (api.favoriteCounts && output.candidates.length) { try { counts = await api.favoriteCounts(output.candidates.map(value => value.id)); } catch { output.favoriteWarning = '收藏人数查询失败，未自动重试。'; } }
          output = withFavoritePreference(output, counts); output.favoriteDemo = demo; break;
        }
        case '/api/create': {
          if (data.confirm !== true) throw new Error('需要明确确认创建歌单');
          if(api.capabilities?.().create===false)throw new Error(api.capabilities().createReason||'当前平台未启用创建。');
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
          assertWritable(api, p, user.id);
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
  server.on('close', () => { ai.clear(); Object.values(platforms).forEach(value => value.clear?.()); });
  return { server, token };
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const { [demo ? 'Demo' : 'Netease']: Adapter } = await import(demo ? './demo.mjs' : './netease.mjs');
  const main = new Adapter();
  const localOrigin='http://127.0.0.1:'+Number(process.env.PORT||8765);
  const spotify=new Spotify(),apple=new AppleMusic({origin:localOrigin});
  if(!demo){
    try{if(process.env.SPOTIFY_CLIENT_ID)spotify.configure({clientId:process.env.SPOTIFY_CLIENT_ID});}catch(error){spotify.configurationError=error.message;}
    try{const developerToken=await appleTokenFromEnvironment(process.env,localOrigin);if(developerToken)apple.configure({developerToken,origin:localOrigin,storefront:process.env.APPLE_MUSIC_STOREFRONT||'us'});}catch(error){apple.configurationError=error.message;}
  }
  const app = createApp(main, { demo, adapters: { netease: main, qq: demo ? new Adapter({ platform: 'qq' }) : new QQMusic(), ...(!demo ? {spotify,apple} : {}) } });
  app.server.listen(Number(process.env.PORT || 8765), '127.0.0.1', () => console.log(`\n本地歌单助手${demo ? '【离线演示】' : ''}\n请打开：http://127.0.0.1:${app.server.address().port}/#${app.token}\n关闭此窗口会清除本工具内存中的登录信息。\n`));
  app.server.on('error', () => { console.error('启动失败，端口可能被占用。请换一个 PORT。'); process.exitCode = 1; });
}
