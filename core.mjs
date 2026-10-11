export const normalize = s => String(s).normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}]/gu, '');
export function coverUrl(input) {
  const value = String(input || '').replace(/^http:\/\/(p[1-9]\.music\.126\.net\/|y\.gtimg\.cn\/)/, 'https://$1');
  try { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password || url.port) return ''; return /^p[1-9]\.music\.126\.net$/.test(url.hostname) || url.hostname === 'y.gtimg.cn' && url.pathname.startsWith('/music/photo_new/') ? url.href : ''; } catch { return ''; }
}
export function parseList(text, order = 'title-first') {
  if (typeof text !== 'string' || text.length > 40000) throw new Error('列表过长，最多 200 首。');
  const rows = [], seen = new Set();
  for (let line of text.split(/\r?\n/)) {
    line = line.trim().replace(/^\s*(?:[-*•]\s+|\d+[.)、]\s*)/, '').replace(/\*\*|`/g, '');
    if (!line || /^\s*(?:#|---|\|?\s*歌名\s*\|)/.test(line)) continue;
    const parts = line.split(/\s+[-–—]\s+|\t+|\s*\|\s*/).map(x => x.trim()).filter(Boolean);
    if (parts.length > 2) throw new Error('一行只能有歌名和歌手，请去掉推荐理由：' + line.slice(0, 70));
    let [title, artist = ''] = parts;
    if (order === 'artist-first' && parts.length === 2) [title, artist] = [artist, title];
    if (!title || title.length > 250 || artist.length > 250) throw new Error('歌名或歌手过长。');
    const key = normalize(title) + '\0' + normalize(artist);
    if (!seen.has(key)) { seen.add(key); rows.push({ title, artist }); }
  }
  if (!rows.length || rows.length > 200) throw new Error('请输入 1–200 首歌曲，每行一首。');
  return rows;
}
const variants = s => [...String(s).toLowerCase().matchAll(/\b(?:live|remix|acoustic|instrumental|karaoke|cover|sped\s*up|slowed|remaster(?:ed)?)\b|现场|翻唱|伴奏|加速|慢速|混音|重制/g)].map(x => x[0]).sort().join('|');
function similarity(a, b) {
  a = normalize(a); b = normalize(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(cur[j - 1] + 1, prev[j] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1]));
    prev = cur;
  }
  return 1 - prev[b.length] / Math.max(a.length, b.length);
}
export function rank(row, songs) {
  const candidates = songs.map(s => {
    const artists = s.ar || s.artists || [];
    const title = String(s.name || ''), album = String(s.al?.name || s.album?.name || '');
    const names = artists.map(x => String(x.name));
    const titleScore = similarity(row.title, title);
    const artistScore = row.artist ? Math.max(0, ...names.map(n => similarity(row.artist, n)), similarity(row.artist, names.join(' / '))) : 0;
    const variantMismatch = variants(row.title) !== variants(title);
    const exact = normalize(row.title) === normalize(title) && !!row.artist && artistScore === 1 && !variantMismatch;
    const pic = String(s.al?.picUrl || s.album?.picUrl || '').replace(/^http:\/\/(p[1-9]\.music\.126\.net\/)/, 'https://$1');
    const cover = coverUrl(pic);
    const year = Number(s.publishTime) > 0 ? new Date(Number(s.publishTime)).getUTCFullYear() : null;
    return { id: String(s.id), platform: s.platform === 'qq' ? 'qq' : 'netease', title, artist: names.join(' / '), album, cover, year, writeBlocked: s.writeBlocked === true, duration: Number(s.dt || s.duration || 0), score: Math.round(100 * (.7 * titleScore + .3 * artistScore - (variantMismatch ? .3 : 0))), exact, variantMismatch };
  }).filter(s => /^\d+$/.test(s.id)).sort((a, b) => b.score - a.score);
  // Different IDs with identical metadata are still ambiguous editions.
  const auto = candidates[0]?.exact && !candidates[0].writeBlocked && !candidates.slice(1).some(s => s.exact);
  return { ...row, candidates: candidates.slice(0, 8), selected: auto ? candidates[0].id : '', status: auto ? '高匹配，仍请预览' : candidates.length ? '请确认版本' : '未找到' };
}
export function withFavoritePreference(row, counts = {}) {
  row.candidates = row.candidates.map(candidate => {
    const data = counts[candidate.id], value = typeof data === 'object' ? data?.value : data;
    return { ...candidate, favorites: Number.isSafeInteger(value) && value >= 0 ? value : null, favoriteDisplay: typeof data?.display === 'string' ? data.display : '', favoriteApproximate: !!data?.approximate };
  });
  const eligible = row.candidates.filter(candidate => candidate.exact && !candidate.writeBlocked);
  row.favoriteStatus = eligible.length && eligible.every(candidate => candidate.favorites !== null) ? 'complete' : 'unavailable';
  row.selectionReason = '收藏数未知 · 按匹配结果展示，仍可换版本';
  if (row.favoriteStatus === 'complete') {
    const max = Math.max(...eligible.map(candidate => candidate.favorites));
    const winners = eligible.filter(candidate => candidate.favorites === max);
    row.selected = winners.length === 1 ? winners[0].id : '';
    row.selectionReason = winners.length === 1 ? eligible.some(candidate => candidate.favoriteApproximate) ? `按平台收藏量级优先 · ${winners[0].favoriteDisplay || max.toLocaleString('zh-CN')}` : `匹配候选中收藏最多 · ${max.toLocaleString('zh-CN')} 人收藏` : '收藏数 / 量级并列 · 请确认发行版本';
  }
  return row;
}
export function playlistId(input, platform = 'netease') {
  const s = String(input).trim();
  if (/^\d+$/.test(s)) return s;
  try {
    const u = new URL(s);
    if (platform === 'qq') {
      if (u.protocol !== 'https:' || u.hostname !== 'y.qq.com') throw 0;
      const pathId = /\/playlist\/(\d+)(?:\.html)?\/?$/.exec(u.pathname)?.[1];
      const id = pathId || (/taoge|playsquare/.test(u.pathname) ? u.searchParams.get('id') || u.searchParams.get('disstid') : '');
      if (/^\d+$/.test(id || '')) return id;
      throw 0;
    }
    if (!['music.163.com', 'y.music.163.com'].includes(u.hostname)) throw 0;
    const id = u.searchParams.get('id') || new URLSearchParams(u.hash.split('?')[1] || '').get('id');
    if (id && /^\d+$/.test(id) && /playlist/.test(u.pathname + u.hash)) return id;
  } catch {}
  throw new Error(`请填写${platform === 'qq' ? 'QQ 音乐' : '网易云'}数字歌单 ID 或完整歌单链接；短链接请先在浏览器打开。`);
}
export function selectedIds(plan, selections) {
  if (!Array.isArray(selections) || selections.length !== plan.length) throw new Error('预览已变化，请重新匹配。');
  const ids = selections.filter(Boolean).map(String);
  selections.forEach((id, i) => { if (id && !plan[i].candidates.some(c => c.id === String(id))) throw new Error('只能选择已搜索到的候选歌曲。'); });
  selections.forEach((id, i) => { if (id && plan[i].candidates.find(c => c.id === String(id))?.writeBlocked) throw new Error('所选歌曲的类型信息不一致，暂不能导入，请跳过或重新匹配。'); });
  if (!ids.length) throw new Error('请至少确认一首歌曲。');
  return [...new Set(ids)];
}
export const delay = ms => new Promise(r => setTimeout(r, ms));
export async function appendVerified(api, pid, uid, ids, onProgress = () => {}) {
  const before = await api.detail(pid);
  if (String(before.creator?.userId) !== String(uid)) throw new Error('只能追加到当前账号自己创建的歌单。');
  if (!Array.isArray(before.trackIds)) throw new Error('没有获得完整歌曲 ID，停止导入。');
  const existing = new Set(before.trackIds.map(x => String(x.id)));
  const pending = [...new Set(ids)].filter(id => !existing.has(id));
  const report = { platform: api.platform || 'netease', playlistId: pid, playlistName: before.name, url: api.playlistUrl?.(pid) || `https://music.163.com/playlist?id=${pid}`, beforeIds: [...existing], requested: ids, skipped: ids.filter(id => existing.has(id)), verified: [], unverified: [], stopped: '', time: new Date().toISOString() };
  for (let i = 0; i < pending.length; i += 10) {
    const batch = pending.slice(i, i + 10);
    try {
      await api.add(pid, batch);
      await api.pause();
      const after = await api.detail(pid);
      if (!Array.isArray(after.trackIds)) throw new Error('无法读取导入后的歌曲 ID');
      const present = new Set(after.trackIds.map(x => String(x.id)));
      report.verified.push(...batch.filter(id => present.has(id)));
      const absent = batch.filter(id => !present.has(id));
      if (absent.length) throw new Error('本批部分歌曲未在歌单中出现，请稍后手动核对');
    } catch (e) {
      report.stopped = e.message;
      report.unverified = pending.filter(id => !report.verified.includes(id));
      // A timed-out write can have succeeded. Never automatically resend it.
      break;
    }
    onProgress(report.verified.length, pending.length);
  }
  return report;
}
