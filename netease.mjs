import { createRequire } from 'node:module';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { delay } from './core.mjs';
const require = createRequire(import.meta.url);
// Import only the upstream encryption function. Do not start its generic API server,
// unlock plugins, logging, device registration or automatic write retries.
const root = path.dirname(require.resolve('@neteasecloudmusicapienhanced/api'));
const { weapi, eapi } = require(path.join(root, 'util', 'crypto.js'));
const QRCode = createRequire(path.join(root, 'main.js'))('qrcode');
const allowed = new Set(['login/qrcode/unikey', 'login/qrcode/client/login', 'w/nuser/account/get', 'cloudsearch/pc', 'user/playlist', 'v6/playlist/detail', 'v3/song/detail', 'playlist/create', 'playlist/manipulate/tracks']);
const stages = { 'login/qrcode/unikey': '二维码生成', 'login/qrcode/client/login': '扫码授权查询', 'w/nuser/account/get': '账号资料验证' };
function mergeCookies(previous, updates) {
  const values = new Map(String(previous).split(';').map(value => value.trim()).filter(value => /^[\w-]+=/.test(value)).map(value => [value.slice(0, value.indexOf('=')), value.slice(value.indexOf('=') + 1)]));
  for (const value of updates) { const pair = String(value).split(';')[0].trim(), equal = pair.indexOf('='); if (equal > 0 && /^[\w-]+$/.test(pair.slice(0, equal)) && !/[\r\n]/.test(pair)) values.set(pair.slice(0, equal), pair.slice(equal + 1)); }
  return [...values].map(([key, value]) => key + '=' + value).join('; ');
}
export class Netease {
  constructor({ transport = globalThis.fetch, wait = delay } = {}) {
    this.cookie = ''; this.lastRequest = 0; this.qrKey = ''; this.qrCookie = ''; this.nextQrCheck = 0;
    this.protocol = 'weapi'; this.verified = false; this.source = ''; this.deviceId = randomUUID(); this.transport = transport; this.wait = wait;
  }
  sessionInfo() { return { hasSession: !!this.cookie, verified: this.verified, source: this.source }; }
  async request(endpoint, data = {}, login = true, options = {}) {
    if (!allowed.has(endpoint)) throw new Error('接口不在允许列表');
    await this.wait(Math.max(0, 1200 - (Date.now() - this.lastRequest)));
    this.lastRequest = Date.now();
    const cookie = options.cookie ?? (login ? this.cookie : '');
    const csrf = /(?:^|;\s*)__csrf=([^;]*)/.exec(cookie)?.[1] || '';
    const protocol = options.protocol || 'weapi';
    if (!['weapi', 'eapi'].includes(protocol)) throw new Error('不支持的请求协议');
    const cookieValues = Object.fromEntries(cookie.split(';').map(value => value.trim()).filter(value => value.includes('=')).map(value => { let data = value.slice(value.indexOf('=') + 1); try { data = decodeURIComponent(data); } catch {} return [value.slice(0, value.indexOf('=')), data]; }));
    const header = { os: 'pc', osver: 'Microsoft-Windows-10', appver: '3.1.17.204416', channel: 'netease', deviceId: this.deviceId, __csrf: csrf, requestId: String(Date.now()) + '_0', ...(cookieValues.MUSIC_U ? { MUSIC_U: cookieValues.MUSIC_U } : {}), ...(cookieValues.NMTID ? { NMTID: cookieValues.NMTID } : {}) };
    const encrypted = protocol === 'eapi' ? eapi('/api/' + endpoint, { ...data, e_r: false, header }) : weapi({ ...data, csrf_token: csrf });
    const requestCookie = protocol === 'eapi' ? mergeCookies(cookie, Object.entries(header).map(([key, value]) => key + '=' + encodeURIComponent(value))) : cookie;
    let response;
    try {
      response = await this.transport(protocol === 'eapi' ? `https://interfacepc.music.163.com/eapi/${endpoint}` : `https://music.163.com/weapi/${endpoint}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://music.163.com/', 'User-Agent': protocol === 'eapi' ? 'Mozilla/5.0 (Windows NT 10.0; WOW64) NeteaseMusicDesktop/3.1.17.204416' : 'Mozilla/5.0', ...(requestCookie ? { Cookie: requestCookie } : {}) },
        body: new URLSearchParams(encrypted),
      });
    } catch { throw new Error('网络失败或超时；若刚刚加歌，结果可能已生效，请先核对歌单。'); }
    let body;
    try { body = await response.json(); } catch { throw new Error('平台返回非 JSON 响应，停止操作。'); }
    const cookies = response.headers.getSetCookie().map(s => s.split(';')[0]);
    return { body, cookies, status: response.status, endpoint };
  }
  check(result, codes = [200]) {
    if (result.status !== 200 || !codes.includes(Number(result.body?.code))) {
      // Don't forward arbitrary upstream text: it may contain credentials.
      const code = Number(result.body?.code || result.status);
      throw new Error(`${stages[result.endpoint] || '网易云请求'}被拒绝（状态 ${Number.isFinite(code) ? code : '未知'}）。请查看官方客户端，不要连续重试。`);
    }
    return result.body;
  }
  async user() {
    if (!this.cookie) throw new Error('请先扫码登录或在本地输入已有 Cookie。');
    const b = this.check(await this.request('w/nuser/account/get', {}, true, { protocol: this.protocol }));
    const id = b.profile?.userId || b.account?.id;
    if (!id) throw new Error('会话未登录或已失效。');
    this.verified = true;
    return { id: String(id), name: String(b.profile?.nickname || '网易云用户') };
  }
  async qr() {
    this.qrCookie = ''; this.qrKey = ''; this.nextQrCheck = 0;
    const result = await this.request('login/qrcode/unikey', { type: 3 }, false, { protocol: 'eapi', cookie: '' });
    const b = this.check(result);
    const key = b.unikey || b.data?.unikey;
    if (!key) throw new Error('未获得二维码 key');
    this.qrCookie = mergeCookies('', result.cookies); this.qrKey = String(key);
    const url = 'https://music.163.com/login?codekey=' + encodeURIComponent(this.qrKey);
    return { image: await QRCode.toDataURL(url), url };
  }
  async qrCheck() {
    if (!this.qrKey) throw new Error('请先生成二维码。');
    if (Date.now() < this.nextQrCheck) throw new Error('扫码状态检查至少间隔 3 秒。');
    this.nextQrCheck = Date.now() + 3000;
    const r = await this.request('login/qrcode/client/login', { key: this.qrKey, type: 3 }, false, { protocol: 'eapi', cookie: this.qrCookie });
    const b = this.check(r, [800, 801, 802, 803]);
    this.qrCookie = mergeCookies(this.qrCookie, r.cookies);
    if (Number(b.code) === 803) {
      if (!/(?:^|;\s*)MUSIC_U=[^;\s]+/.test(this.qrCookie)) throw new Error('手机已授权，但平台未返回可用会话。可使用官方网页已有 Cookie。');
      this.cookie = this.qrCookie; this.qrKey = ''; this.protocol = 'eapi'; this.verified = false; this.source = 'qr';
      try { return { code: 803, authorized: true, user: await this.user() }; }
      catch (error) { return { code: 803, authorized: true, user: null, warning: error.message + ' 已保留授权会话，可单独验证。' }; }
    }
    if (Number(b.code) === 800) this.qrKey = '';
    return { code: Number(b.code) };
  }
  async setCookie(value) {
    if (typeof value !== 'string' || value.length > 16000 || /[\r\n]/.test(value) || !/(?:^|;\s*)MUSIC_U=/.test(value)) throw new Error('Cookie 格式错误，需要包含 MUSIC_U。');
    const previous = { cookie: this.cookie, protocol: this.protocol, source: this.source, verified: this.verified };
    this.cookie = value.trim(); this.protocol = 'weapi'; this.source = 'cookie'; this.verified = false;
    try { return await this.user(); } catch (e) { Object.assign(this, previous); throw e; }
  }
  async search(row) {
    const b = this.check(await this.request('cloudsearch/pc', { s: [row.title, row.artist].filter(Boolean).join(' '), type: 1, limit: 20, offset: 0, total: true }, false));
    return b.result?.songs || [];
  }
  async playlists(uid) {
    const result = [];
    for (let offset = 0; offset < 5000; offset += 100) {
      const b = this.check(await this.request('user/playlist', { uid, limit: 100, offset, includeVideo: false }));
      const rows = b.playlist || [];
      result.push(...rows.filter(p => String(p.creator?.userId) === uid).map(p => ({ id: String(p.id), name: p.name, count: p.trackCount, privacy: p.privacy })));
      if (!b.more || !rows.length) return result;
    }
    throw new Error('歌单超过 5000 个，请填写具体 ID。');
  }
  async detail(id) { return this.check(await this.request('v6/playlist/detail', { id, n: 100000, s: 0 })).playlist; }
  async readPlaylist(id) {
    const playlist = await this.detail(id);
    if (!Array.isArray(playlist?.trackIds)) throw new Error('未获得完整歌单曲目。');
    const all = playlist.trackIds.map(track => String(track.id));
    const ids = all.length > 200 ? Array.from({ length: 200 }, (_, index) => all[Math.floor(index * (all.length - 1) / 199)]) : all;
    const songs = [];
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = ids.slice(offset, offset + 100);
      const body = this.check(await this.request('v3/song/detail', { c: JSON.stringify(batch.map(id => ({ id }))) }));
      songs.push(...(body.songs || []));
    }
    const byId = new Map(songs.map(song => [String(song.id), song]));
    const tracks = ids.map(id => byId.get(id)).filter(Boolean).map(song => ({ id: String(song.id), title: String(song.name), artist: (song.ar || []).map(value => value.name).join(' / '), album: song.al?.name || '', cover: /^https:\/\/p[1-9]\.music\.126\.net\//.test(song.al?.picUrl || '') ? song.al.picUrl : '', year: Number(song.publishTime) > 0 ? new Date(Number(song.publishTime)).getUTCFullYear() : null }));
    if (!tracks.length) throw new Error('歌单为空或曲目信息暂不可读取。');
    return { id, title: String(playlist.name), total: all.length, sampled: all.length > 200, unavailable: ids.length - tracks.length, tracks };
  }
  async create(name, privacy = '10') {
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('歌单名称为 1–80 字。');
    const b = this.check(await this.request('playlist/create', { name: name.trim(), privacy: privacy === '0' ? '0' : '10', type: 'NORMAL' }));
    const id = b.playlist?.id || b.id;
    if (!id) throw new Error('未返回新歌单 ID，请到官方客户端核对，避免重复创建。');
    return { id: String(id), name: b.playlist?.name || name };
  }
  async add(pid, ids) { this.check(await this.request('playlist/manipulate/tracks', { op: 'add', pid, trackIds: JSON.stringify(ids), imme: 'true' })); }
  async readForPrune(id) {
    const playlist = await this.detail(id), ids = playlist?.trackIds?.map(value => String(value.id));
    if (!ids || ids.length > 1000 || Number(playlist.trackCount) !== ids.length) throw new Error('整理需要完整歌单，首版最多 1000 首；不会使用抽样结果删除。');
    const tracks = [];
    for (let offset=0;offset<ids.length;offset+=100) {
      const batch=ids.slice(offset,offset+100), body=this.check(await this.request('v3/song/detail',{c:JSON.stringify(batch.map(id=>({id})))}));
      const byId=new Map((body.songs||[]).map(value=>[String(value.id),value]));
      if(batch.some(id=>!byId.has(id)))throw new Error('部分歌曲无法读取，停止整理。');
      tracks.push(...batch.map(id=>byId.get(id)));
    }
    return {...playlist,tracks};
  }
  async remove(pid, ids, snapshot) {
    if (!this.verified || String(snapshot?.id)!==String(pid) || !Array.isArray(ids) || !ids.length || ids.length>10 || new Set(ids).size!==ids.length || ids.some(id=>typeof id!=='string'||!/^\d{1,20}$/.test(id)||!snapshot.trackIds?.some(value=>String(value.id)===id))) throw new Error('删除仅允许当前完整歌单中已核对的歌曲，每批最多 10 首。');
    this.check(await this.request('playlist/manipulate/tracks',{op:'del',pid,trackIds:JSON.stringify(ids),imme:'true'}));
  }
  pause() { return delay(2000); }
  clear() { this.cookie = ''; this.qrKey = ''; this.qrCookie = ''; this.protocol = 'weapi'; this.verified = false; this.source = ''; }
}
