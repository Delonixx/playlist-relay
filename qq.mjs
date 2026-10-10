import { delay, coverUrl } from './core.mjs';
import { QQLogin } from './qq-login.mjs';

// Independent, narrow Web adapter. Protocol references: QQ接入.md.
// No audio, deletion, device emulation, credential files or write retries.
const rpc = {
  search: ['music.adaptor.SearchAdaptor', 'do_search_v2'],
  user: ['music.UserInfo.userInfoServer', 'GetLoginUserInfo'],
  playlists: ['music.musicasset.PlaylistBaseRead', 'GetPlaylistByUin'],
  detail: ['music.srfDissInfo.DissInfo', 'CgiGetDiss'],
  create: ['music.musicasset.PlaylistBaseWrite', 'AddPlaylist'],
  add: ['music.musicasset.PlaylistDetailWrite', 'AddSonglist'],
  favorites: ['music.musicasset.SongFavRead', 'GetSongFansNumberById'],
  qqLogin: ['QQConnectLogin.LoginServer', 'QQLogin'],
  wxLogin: ['music.login.LoginServer', 'Login']
};
const decimal = value => {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('QQ 返回了不精确的数字 ID，已停止。');
  const result = String(value ?? '');
  if (!/^\d{1,20}$/.test(result)) throw new Error('QQ 音乐 ID 格式无效。');
  return BigInt(result).toString();
};
const int = value => { const result = Number(decimal(value)); if (!Number.isSafeInteger(result)) throw new Error('QQ ID 超出安全整数范围，已停止。'); return result; };
const hash33 = value => { let result = 5381; for (const char of value) result = (result * 33 + char.charCodeAt(0)) | 0; return result & 0x7fffffff; };
export function parseQQCookie(raw) {
  if (typeof raw !== 'string' || raw.length > 12000 || /[\r\n]/.test(raw)) throw new Error('请填写有效的 QQ 音乐 Cookie。');
  const pairs = new Map();
  for (const part of raw.split(';')) { const value = part.trim(), at = value.indexOf('='); if (at > 0) pairs.set(value.slice(0, at), value.slice(at + 1)); }
  const wx = (pairs.get('login_type') || pairs.get('tmeLoginType')) === '2';
  const id = decimal((wx ? pairs.get('wxuin') : null) || pairs.get('qqmusic_uin') || pairs.get('uin')?.replace(/^o(?=\d)/, '') || pairs.get('musicid'));
  const key = pairs.get('qqmusic_key') || pairs.get('qm_keyst');
  if (!key || key.length > 1000 || /\s/.test(key)) throw new Error('QQ Cookie 需要 uin（微信为 wxuin）及 qqmusic_key 或 qm_keyst。');
  const cookie = `uin=${id}; qqmusic_key=${key}; qm_keyst=${key};${wx ? ` wxuin=${id}; login_type=2; tmeLoginType=2;` : ' login_type=1; tmeLoginType=1;'}`;
  return { id, key, cookie };
}
export function qqSong(song) {
  const id = decimal(song.id), type = int(song.type);
  const mid = [song.album?.pmid, song.album?.mid].find(value => /^[a-zA-Z0-9_]{1,60}$/.test(value || '')) || '';
  const pic = mid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${mid}.jpg` : '';
  return { id, name: String(song.title || song.name || '').replace(/<\/?em>/g, ''), ar: (song.singer || []).map(value => ({ name: String(value.name || '').replace(/<\/?em>/g, '') })), al: { name: String(song.album?.name || ''), picUrl: pic }, dt: Number(song.interval || 0) * 1000, songType: type, platform: 'qq', publishTime: Date.parse(song.time_public || '') || 0 };
}
export function qqFavoriteDisplay(display) {
  if (typeof display !== 'string' || display.length > 30) return null;
  const match = /^(\d+(?:\.\d+)?)(w|k|m|万|亿)?(\+)?$/i.exec(display.trim());
  if (!match) return null;
  const multiplier = { w: 1e4, k: 1e3, m: 1e6, 万: 1e4, 亿: 1e8 }[match[2]?.toLowerCase()] || 1;
  const value = Number(match[1]) * multiplier;
  if (!Number.isSafeInteger(value) || value < 0) return null;
  return { value, display: display.trim(), approximate: !!(match[2] || match[3]) };
}
export class QQMusic {
  constructor({ transport = globalThis.fetch, wait = delay } = {}) {
    this.platform = 'qq'; this.name = 'QQ 音乐'; this.transport = transport; this.wait = wait;
    this.credential = null; this.verified = false; this.lastRequest = 0; this.songTypes = new Map(); this.directories = new Map();
    this.login = new QQLogin({ transport, wait,
      exchange: (mode, params) => this.request(mode === 'wx' ? 'wxLogin' : 'qqLogin', params, false, { tmeLoginType: mode === 'wx' ? 1 : 2 }),
      adopt: (data, mode) => this.adoptQR(data, mode) });
  }
  capabilities() { return { qr: true, qrTypes: ['qq','wx'], autoQr: true, create: true, privateCreate: false, favorites: true, experimental: true }; }
  sessionInfo() { return { hasSession: !!this.credential, verified: this.verified, source: this.credential?.source || (this.credential ? 'cookie' : '') }; }
  async request(name, param = {}, authenticated = true, comm = {}) {
    if (!Object.hasOwn(rpc, name)) throw new Error('QQ 接口不在允许列表。');
    if (authenticated && !this.credential) throw new Error('请先连接 QQ 音乐 Cookie。');
    await this.wait(Math.max(0, 1200 - (Date.now() - this.lastRequest))); this.lastRequest = Date.now();
    const credential = authenticated ? this.credential : null, [module, method] = rpc[name], gtk = hash33(credential?.key || '');
    let response;
    try { response = await this.transport('https://u.y.qq.com/cgi-bin/musicu.fcg', {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20000),
      headers: { 'Content-Type': 'application/json', Referer: 'https://y.qq.com/', 'User-Agent': 'Mozilla/5.0', ...(credential ? { Cookie: credential.cookie } : {}) },
      body: JSON.stringify({ comm: { ct: '24', cv: '4747474', platform: 'yqq.json', uin: credential?.id || '0', g_tk: String(gtk), g_tk_new_20200303: String(gtk), format: 'json', inCharset: 'utf-8', outCharset: 'utf-8', notice: '0', needNewCode: '1', ...comm }, req: { module, method, param } })
    }); } catch { throw new Error('QQ 网络失败或超时；若刚刚加歌，请先在官方客户端核对。'); }
    if (!response.ok) throw new Error(`QQ 请求未完成（HTTP ${response.status}）。`);
    let text = '', size = 0; const reader = response.body.getReader(), decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > 2000000) { await reader.cancel(); throw new Error('QQ 响应过大，已停止。'); } text += decoder.decode(value, { stream: true }); }
    let body; try { body = JSON.parse(text + decoder.decode()); } catch { throw new Error('QQ 响应格式无效。'); }
    const block = body.req;
    for (const code of [body.code, block?.code, block?.data?.code, block?.data?.retCode, block?.data?.subcode]) {
      if (code !== undefined && Number(code) !== 0) throw new Error(`QQ 拒绝「${name}」请求（状态 ${Number(code)}）。请在官方客户端检查，不要连续重试。`);
    }
    if (body.code === undefined || !block || block.code === undefined || !block.data || typeof block.data !== 'object') throw new Error('QQ 未返回完整业务结果，已停止。');
    return block.data;
  }
  async user() {
    if (!this.credential) throw new Error('请先连接 QQ 音乐 Cookie。');
    this.verified = false;
    const data = await this.request('user'), info = data.info || data.userInfo || data.user_info || data;
    const actual = info.musicid ?? info.musicId ?? info.uin;
    if (actual !== undefined && decimal(actual) !== this.credential.id || !String(info.nick || info.nickname || info.nickName || '').trim()) throw new Error('QQ 登录结果未能确认当前账号身份，请重新获取官方登录 Cookie。');
    this.verified = true; return { id: this.credential.id, name: String(info.nick || info.nickname || info.nickName || 'QQ 音乐用户') };
  }
  async setCookie(raw) {
    const next = parseQQCookie(raw), previous = this.credential, verified = this.verified;
    this.credential = next; this.verified = false;
    try { const user = await this.user(); this.login.cancel(); this.directories.clear(); this.songTypes.clear(); return user; }
    catch (error) { this.credential = previous; this.verified = verified; throw error; }
  }
  async qr(mode = 'qq') { return this.login.create(mode); }
  async qrCheck() { return this.login.check(); }
  qrCancel() { this.login.cancel(); }
  async adoptQR(data, mode) {
    const id = decimal(data.str_musicid || data.musicid), key = data.musickey;
    if (id === '0' || typeof key !== 'string' || !key || key.length > 1000 || /[\s;]/.test(key)) throw new Error('已确认扫码，但 QQ 未返回可用音乐会话，请重新生成。');
    this.credential = { ...parseQQCookie(`uin=${id}; qqmusic_key=${key};${mode === 'wx' ? ` wxuin=${id}; login_type=2;` : ''}`), source: 'qr' };
    this.verified = false; this.directories.clear(); this.songTypes.clear();
    try { return { code: 803, authorized: true, user: await this.user() }; }
    catch (error) { return { code: 803, authorized: true, user: null, warning: error.message + ' 已保留授权会话，可单独验证。' }; }
  }
  async search(row) {
    const data = await this.request('search', { query: row.title + ' ' + row.artist, searchid: String(Date.now()), page_id: 1, page_num: 25, search_type: 100, highlight: false, grp: true }, false);
    if (!Array.isArray(data.body?.item_song?.items)) throw new Error('QQ 搜索结构已变化。');
    const songs = data.body.item_song.items.slice(0, 25).map(qqSong);
    songs.forEach(song => this.rememberSong(song));
    const seen = new Set();
    return songs.filter(song => !seen.has(song.id) && seen.add(song.id)).map(song => ({ ...song, writeBlocked: this.songTypes.get(song.id) === null }));
  }
  rememberSong(song) {
    // Search and playlist endpoints are independent snapshots. A conflict must
    // block writes of that ID, not unrelated read-only cover browsing.
    this.songTypes.set(song.id, this.songTypes.has(song.id) && this.songTypes.get(song.id) !== song.songType ? null : song.songType);
  }
  resetSearchTypes() { this.songTypes.clear(); }
  async favoriteCounts(ids) {
    if (!Array.isArray(ids) || ids.length > 25) throw new Error('每次最多查询 25 首歌曲的收藏人数。');
    if (!ids.length) return {};
    const data = await this.request('favorites', { v_songId: ids.map(int) }, false), numbers = data.m_numbers;
    if (!numbers || typeof numbers !== 'object' || Array.isArray(numbers)) throw new Error('QQ 收藏人数暂不可用。');
    // m_numbers can contain coarse buckets (e.g. 1000001 for both 5700w+ and 340w+).
    // Preserve the platform display; never present these buckets as exact people.
    return Object.fromEntries(ids.map(id => [id, qqFavoriteDisplay(data.m_show?.[id])]).filter(([, value]) => value));
  }
  async playlists(uid) {
    if (!this.verified || decimal(uid) !== this.credential?.id) throw new Error('请先验证当前 QQ 账号。');
    const data = await this.request('playlists', { uin: decimal(uid) });
    if (!Array.isArray(data.v_playlist) || data.bFinish !== true && data.bFinish !== 1) throw new Error('QQ 未返回完整自建歌单列表，请用完整歌单链接。');
    const lists = data.v_playlist.filter(value => decimal(value.uin) === String(uid)).map(value => ({ id: decimal(value.tid ?? value.id), dirId: int(value.dirId ?? value.dirid), name: String(value.title ?? value.dirName ?? value.name ?? ''), count: int(value.songNum ?? value.songnum ?? 0) }));
    for (const list of lists) this.directories.set(list.id, list.dirId);
    return lists.filter(value => value.dirId !== 201);
  }
  async detail(id) {
    id = decimal(id); const tracks = [], seen = new Set(); let total = null, info;
    for (let begin = 0; begin < 10000; begin += 100) {
      const data = await this.request('detail', { disstid: int(id), dirid: 0, song_begin: begin, song_num: 100, tag: true, userinfo: true, orderlist: true, onlysonglist: false });
      const currentTotal = data.total_song_num;
      if (!Number.isSafeInteger(currentTotal) || currentTotal < 0 || currentTotal > 10000 || !Array.isArray(data.songlist) || !data.dirinfo) throw new Error('QQ 未返回完整歌单分页信息。');
      if (total !== null && total !== currentTotal) throw new Error('QQ 歌单正在变化，请重新读取。');
      total = currentTotal; info ||= data.dirinfo;
      if (decimal(data.dirinfo.id ?? data.dirinfo.tid ?? data.dirinfo.dissid) !== id) throw new Error('QQ 返回的歌单 ID 不一致。');
      const owner = decimal(data.dirinfo.creator?.musicid);
      if (info.creator?.musicid !== data.dirinfo.creator?.musicid) throw new Error('QQ 歌单身份发生变化。');
      for (const raw of data.songlist) { const song = qqSong(raw); if (seen.has(song.id)) throw new Error('QQ 分页重复，无法完整核验。'); seen.add(song.id); tracks.push(song); }
      if (tracks.length === total && !data.hasmore) {
        const dirId = int(info.dirid ?? info.dirId);
        if (this.verified && owner === this.credential?.id) this.directories.set(id, dirId); else this.directories.delete(id);
        return { id, name: String(info.title ?? info.dirName ?? info.name ?? ''), creator: { userId: owner }, dirId, trackIds: tracks.map(song => ({ id: song.id })), tracks };
      }
      if (!data.songlist.length || !data.hasmore) throw new Error('QQ 歌单分页不完整，停止导入。');
    }
    throw new Error('QQ 歌单超过读取上限。');
  }
  async readPlaylist(id) {
    const data = await this.detail(id), all = data.tracks;
    if (!all.length) throw new Error('QQ 歌单为空。');
    const sampled = all.length > 200, songs = sampled ? Array.from({ length: 200 }, (_, i) => all[Math.floor(i * (all.length - 1) / 199)]) : all;
    return { platform: 'qq', id, title: data.name, total: all.length, sampled, tracks: songs.map(song => ({ id: song.id, title: song.name, artist: song.ar.map(value => value.name).join(' / '), album: song.al.name, cover: coverUrl(song.al.picUrl), year: song.publishTime ? new Date(song.publishTime).getUTCFullYear() : null })) };
  }
  async create(name, privacy) {
    if (!this.verified) throw new Error('请先验证当前 QQ 账号。');
    if (privacy !== '0') throw new Error('QQ 创建接口未确认支持私密；请在官方客户端新建私密歌单后读取，或明确选择公开。');
    if (typeof name !== 'string' || !name.trim() || name.length > 80) throw new Error('歌单名称为 1–80 字。');
    const data = await this.request('create', { dirName: name.trim() });
    if (data.retCode !== 0 || !data.result) throw new Error('QQ 未确认创建，请到官方客户端核对，勿重复创建。');
    const id = decimal(data.result.tid); this.directories.set(id, int(data.result.dirId)); return { id, name: String(data.result.dirName || name) };
  }
  async add(pid, ids) {
    if (!this.verified || !this.directories.has(pid) || this.directories.get(pid) === 201) throw new Error('请先验证账号并读取自己的普通 QQ 歌单。');
    if (!ids.length || ids.length > 10 || ids.some(id => !this.songTypes.has(id))) throw new Error('QQ 加歌仅允许已搜索到的歌曲，每批最多 10 首。');
    if (ids.some(id => this.songTypes.get(id) === null)) throw new Error('所选 QQ 曲目在搜索中返回了不同类型，暂不能导入；封面仍可浏览，请重新匹配后核对。');
    const data = await this.request('add', { dirId: this.directories.get(pid), tid: int(pid), bFmtUtf8: true, v_songInfo: ids.map(id => ({ songId: int(id), songType: this.songTypes.get(id) })) });
    if (data.retCode !== 0) throw new Error('QQ 未明确确认本批加歌，请先核对官方歌单。');
  }
  async pause() { await this.wait(1500); }
  playlistUrl(id) { return `https://y.qq.com/n/ryqq/playlist/${decimal(id)}`; }
  clear() { this.login.cancel(); this.credential = null; this.verified = false; this.directories.clear(); this.songTypes.clear(); }
}
