'use strict';

// The local server owns this token. Never invent one or store account credentials.
const localToken = location.hash.slice(1);
// The fragment is never sent to remote servers; retaining it supports refreshing.
// No music-platform Cookie or AI Key is placed in browser storage.
history.replaceState(null, '', '/#' + localToken);
const $ = id => document.getElementById(id);
const state = { platform: 'netease', platforms: ['netease'], capabilities: { qr: true, privateCreate: true }, connected: false, demo: false, user: null, session: {}, pending: false, phase: 'idle', rows: [], choices: [], remembered: [], skipped: new Set(), revision: '', report: null, confirm: null, candidateIndex: -1, candidateId: '', qrReady: false, nextQrCheck: 0, polling: false, suspended: false, requestedVersions: [] };
state.qqQrType = 'qq'; state.qrExpires = 0; state.loginIntent = '';
let qrTimer = null, qrEpoch = 0, qrWork = null, qrSwitching = false;
state.qrWorking = false;
const platformName = () => ({netease:'网易云',qq:'QQ 音乐',spotify:'Spotify',apple:'Apple Music'})[state.platform] || '音乐平台';
const playlistLink = id => state.platform === 'qq' ? 'https://y.qq.com/n/ryqq/playlist/' + id : state.platform === 'spotify' ? 'https://open.spotify.com/playlist/'+id : state.platform === 'apple' ? 'https://music.apple.com/library/playlists' : 'https://music.163.com/playlist?id=' + id;
const isCover = value => { try { const u=new URL(value); return u.protocol==='https:'&&!u.port&&!u.username&&!u.password&&(/^p[1-9]\.music\.126\.net$/.test(u.hostname)||u.hostname==='y.gtimg.cn'&&u.pathname.startsWith('/music/photo_new/')||u.hostname==='i.scdn.co'&&u.pathname.startsWith('/image/')||/^is[1-9]-ssl\.mzstatic\.com$/.test(u.hostname)); } catch{return false;} };
const activeJob = () => ['matching', 'importing'].includes(state.phase);
const locked = () => state.pending || activeJob();
const selectedCount = () => state.choices.filter(Boolean).length;
const uniqueCount = () => new Set(state.choices.filter(Boolean)).size;
const originalText = row => row.title + (row.artist ? ' — ' + row.artist : '');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

function element(tag, className = '', content = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== '') node.textContent = String(content);
  return node;
}
function sourceLink(url,label='查看曲目 ↗') {
  const link=element('a','music-source-link',state.platform==='spotify'?'':platformName()+' · '+label);
  link.href=url;link.target='_blank';link.rel='noopener noreferrer';
  if(state.platform==='spotify'){const logo=element('img','spotify-logo');logo.src='/spotify-logo.svg';logo.alt='Spotify';link.append(logo,element('span','',label));}
  return link;
}
function toggle(id, visible) { $(id).classList.toggle('hidden', !visible); }
function toast(message) {
  const node = element('div', 'toast', message);
  $('toast-container').append(node);
  setTimeout(() => node.remove(), 4500);
}
function notice(message = '') {
  $('notice-text').textContent = message;
  toggle('notice', !!message);
  toggle('btn-resume', state.suspended);
}
async function api(path, data = {}) {
  if (!localToken) throw new Error('缺少本次访问令牌。请从启动窗口复制完整地址（包含 # 后的字符串）重新打开。');
  const response = await fetch('/api/' + path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Local-Token': localToken }, body: JSON.stringify({ expectedPlatform: state.platform, ...data }) });
  let result;
  try { result = await response.json(); } catch { throw new Error('本地服务没有返回有效结果，请检查启动窗口。'); }
  if (!response.ok) throw new Error(result.error || '操作未完成，请查看本地服务状态。');
  return result;
}
async function run(action, errorId = '') {
  if (locked()) return;
  state.pending = true;
  if (errorId) { $(errorId).textContent = ''; toggle(errorId, false); }
  else notice();
  sync();
  try { await action(); }
  catch (error) {
    const message = error.message || '操作未完成。';
    if (errorId) { $(errorId).textContent = message; toggle(errorId, true); }
    else notice(message);
  } finally { state.pending = false; sync(); }
}
function targetId(value) {
  const text = String(value).trim();
  if(state.platform==='spotify'){
    if(/^[A-Za-z0-9]{22}$/.test(text))return text;
    const uri=/^spotify:playlist:([A-Za-z0-9]{22})$/.exec(text);if(uri)return uri[1];
    try{const u=new URL(text),id=/^\/playlist\/([A-Za-z0-9]{22})\/?$/.exec(u.pathname)?.[1];if(u.protocol==='https:'&&u.hostname==='open.spotify.com'&&!u.port&&!u.username&&!u.password&&id)return id;}catch{}return '';
  }
  if(state.platform==='apple')return /^p\.[A-Za-z0-9.-]{2,100}$/.test(text)?text:'';
  if (/^\d+$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (state.platform === 'qq') {
      const id = /\/playlist\/(\d+)(?:\.html)?\/?$/.exec(url.pathname)?.[1] || (/taoge|playsquare/.test(url.pathname) ? url.searchParams.get('id') || url.searchParams.get('disstid') : '');
      return url.protocol === 'https:' && url.hostname === 'y.qq.com' && /^\d+$/.test(id || '') ? id : '';
    }
    const id = url.searchParams.get('id') || new URLSearchParams(url.hash.split('?')[1] || '').get('id');
    if (['music.163.com', 'y.music.163.com'].includes(url.hostname) && /playlist/.test(url.pathname + url.hash) && /^\d+$/.test(id || '')) return id;
  } catch {}
  return '';
}
function revokeConfirm() {
  state.confirm = null;
  if ($('modal-confirm').open) $('modal-confirm').close();
}
function resetPlan() {
  revokeConfirm();
  state.rows = []; state.choices = []; state.remembered = []; state.skipped.clear(); state.revision = ''; state.report = null;
  state.requestedVersions = [];
  toggle('result-zone', false); toggle('progress-zone', false);
  renderRows();
}
function sync() {
  document.body.dataset.platform=state.platform;
  const busy = locked();
  const canUse = state.connected && !busy;
  const hasUser = !!state.user;
  $('music-platform').value = state.platform; $('music-platform').disabled = busy || !state.connected || state.platforms.length < 2;
  document.querySelectorAll('#music-platform option').forEach(option=>option.disabled=!state.platforms.includes(option.value));
  $('login-title').textContent = '登录' + platformName(); $('cookie-label').textContent = '仅粘贴你在' + platformName() + '官方网页的 Cookie';
  $('input-cookie').placeholder = state.platform === 'qq' ? 'uin=...; qqmusic_key=... 或 qm_keyst=...' : 'MUSIC_U=...; __csrf=...';
  $('login-help').textContent = state.platform === 'qq' ? state.capabilities.qr === false ? '当前服务仍是旧版，请重启 start.cmd 启用扫码；Cookie 可临时备用。' : '使用手机 QQ 或微信扫码，确认后自动连接。无需查找 Cookie 或填写密码。' : '扫码或使用官方网页的已有 Cookie，无需提供账号密码。';
  if (state.qrDisplayPlatform !== state.platform) { state.qrDisplayPlatform = state.platform; $('qr-status').textContent = state.platform === 'qq' ? '用手机 QQ 或微信扫码，随后在手机确认。' : '用网易云 App 扫码并确认。'; }
  toggle('qq-qr-types', state.platform === 'qq'); toggle('qr-auto-hint', state.capabilities.autoQr === true);
  ['qq','wx'].forEach(type => { $('btn-qr-' + type).classList.toggle('active', state.qqQrType === type); $('btn-qr-' + type).setAttribute('aria-pressed', String(state.qqQrType === type)); $('btn-qr-' + type).disabled = (!canUse && !state.qrWorking) || state.demo || qrSwitching; });
  $('official-login-link').href = state.platform === 'qq' ? 'https://y.qq.com/' : 'https://music.163.com/';
  toggle('platform-note', state.platform === 'qq');
  document.querySelectorAll('.tab-btn').forEach(button => { if (button.dataset.tab === 'qr') button.disabled = state.capabilities.qr === false; });
  if (state.capabilities.qr === false) { toggle('login-tab-qr', false); toggle('login-tab-cookie', true); document.querySelectorAll('.tab-btn').forEach(button => button.classList.toggle('active', button.dataset.tab === 'cookie')); }
  const oauth=state.capabilities.oauth===true;
  toggle('login-native-tabs',!oauth);toggle('login-tab-oauth',oauth);toggle('official-login-link',!oauth);
  if(oauth){
    toggle('login-tab-qr',false);toggle('login-tab-cookie',false);
    $('login-help').textContent='通过官方网页授权连接，凭证保存在本次本地服务会话。';
    $('oauth-config-help').textContent=state.platform==='spotify'?'需要自己的 Spotify 开发应用和 Premium。测试用户须加入应用名单；这里仅填写 Client ID，不需要 Client Secret。':'需要 Apple Developer Program 的 MusicKit 已签名 Developer Token。账号通过 Apple 官方组件授权；无需填写密码或私钥。';
    $('oauth-credential-label').textContent=state.platform==='spotify'?'Spotify Client ID':'MusicKit Developer Token（JWT）';
    $('input-oauth-credential').type=state.platform==='spotify'?'text':'password';
    $('input-oauth-credential').placeholder=state.platform==='spotify'?'32 位 Client ID':'已签名 JWT；不是 .p8 私钥';
    $('oauth-doc-link').href=state.platform==='spotify'?'https://developer.spotify.com/dashboard':'https://developer.apple.com/musickit/';
    toggle('oauth-storefront-group',state.platform==='apple');
    $('oauth-redirect').textContent=state.platform==='spotify'?'在 Spotify 应用里登记此回调地址：'+location.origin+'/oauth/spotify/callback':'搜索地区会在授权后自动采用当前 Apple Music 账号的地区。';
    $('oauth-config-status').textContent=state.session.configurationError?'启动配置未生效：'+state.session.configurationError:state.user?'已连接，可选择歌单。':state.session.configured?'本次配置已保存，下一步打开官方授权页面。':'尚未配置。保存后才能生成授权入口。';
    $('btn-oauth-save').disabled=!canUse||state.demo;
    $('btn-oauth-open').disabled=!canUse||state.demo||!state.session.configured;
    $('btn-oauth-check').disabled=!canUse||state.demo;
    $('input-oauth-credential').disabled=!canUse||state.demo;
    $('input-oauth-storefront').disabled=!canUse||state.demo;
  }
  toggle('platform-note',state.platform!=='netease');
  if(state.platform==='qq')$('platform-note').textContent='QQ 音乐：已获用户实测可用反馈，使用非官方接口；平台拒绝时停止。';
  if(state.platform==='spotify')$('platform-note').textContent='Spotify · 测试版 Beta：官方授权接入；真实账号尚待验证。此平台用于歌单导入，AI 画像与点评不可用。';
  if(state.platform==='apple')$('platform-note').textContent='Apple Music · 测试版 Beta：通过 MusicKit 授权，追加到资料库中可编辑的已有歌单。真实授权和写入尚待验证。';
  $('input-target').placeholder=state.platform==='spotify'?'Spotify 完整链接或歌单 ID':state.platform==='apple'?'从“选择歌单”获取资料库 ID':platformName()+'完整链接或数字 ID';
  ['input-tracks', 'input-order', 'btn-sample', 'btn-empty-sample'].forEach(id => $(id).disabled = !canUse);
  $('btn-match').disabled = !canUse || !$('input-tracks').value.trim();
  $('btn-match').textContent = state.phase === 'matching' ? '正在搜索…' : '搜索并匹配 →';
  $('btn-login-modal').disabled = !canUse || state.demo;
  $('btn-login-modal').textContent = hasUser ? '账号与登录' : '登录' + platformName();
  $('user-info').textContent = state.demo ? '模拟账号 · 未连接音乐平台' : hasUser ? state.user.name : state.connected ? '尚未登录' : '未连接本地服务';
  toggle('demo-badge', state.demo);
  $('btn-select-playlist').disabled = !canUse;
  $('input-target').disabled = !canUse || !hasUser;
  if (!hasUser) $('selected-playlist-name').textContent = '登录并选择歌单';
  ['btn-refresh-playlists', 'btn-create-playlist', 'input-new-playlist', 'input-privacy'].forEach(id => $(id).disabled = !canUse || !hasUser);
  ['btn-generate-qr', 'btn-submit-cookie', 'input-cookie'].forEach(id => $(id).disabled = !canUse || state.demo);
  $('btn-generate-qr').disabled ||= state.capabilities.qr === false;
  $('btn-create-playlist').disabled ||= state.capabilities.privateCreate === false && $('input-privacy').value !== '0';
  $('btn-create-playlist').disabled ||= state.capabilities.create === false;
  toggle('create-playlist-zone',state.capabilities.create!==false);toggle('playlist-create-note',state.capabilities.create===false);
  $('playlist-create-note').textContent=state.capabilities.createReason||'';
  $('create-privacy-note').textContent = state.capabilities.privateCreate === false ? 'QQ 接口未确认支持私密。私密歌单请在官方客户端新建；此处必须选择公开才能创建。' : '新歌单默认私密。';
  $('btn-check-qr').disabled = !canUse || !state.qrReady || Date.now() < state.nextQrCheck;
  $('btn-clear-login').disabled = !canUse;
  toggle('btn-clear-login', (hasUser || state.session.hasSession) && !state.demo);
  $('btn-verify-session').disabled = !canUse || !state.session.hasSession || state.demo;
  $('btn-execute-import').disabled = !canUse || !hasUser || !state.revision || !selectedCount() || !targetId($('input-target').value);
  $('btn-execute-import').textContent = state.phase === 'importing' ? '追加并核验中…' : state.demo ? '核对并模拟导入' : '核对并导入';
  $('btn-export-text').disabled = !selectedCount() || busy;
  $('btn-export-report').disabled = !state.report || busy;
  $('btn-confirm-candidate').disabled = busy || !state.candidateId;
  $('btn-confirm-import').disabled = busy || !state.confirm;
  $('btn-resume').disabled = state.pending || state.polling;
  const count = selectedCount(), review = state.rows.filter((row, i) => row.candidates.length && !state.choices[i] && !state.skipped.has(i)).length, missing = state.rows.filter(row => !row.candidates.length).length;
  $('stats-selected').textContent = count + ' 已选';
  $('stats-review').textContent = review + ' 待核对';
  $('stats-missing').textContent = missing + ' 未找到';
  $('input-count').textContent = $('input-tracks').value.split(/\r?\n/).filter(line => line.trim()).length + ' 行';
  $('match-summary').textContent = activeJob() ? (state.phase === 'matching' ? '正在逐首搜索，请稍候。' : '正在追加与读回，请等待核验结果。') : state.report ? '本次操作已结束。再次导入请重新匹配。' : state.rows.length ? `已选 ${count} / ${state.rows.length} 首${review ? `，${review} 首待核对` : ''}${count !== uniqueCount() ? `（${uniqueCount()} 个独立歌曲 ID）` : ''}。` : '先匹配，再确认喜欢的版本。';
  document.querySelectorAll('.track-list button,.track-checkbox').forEach(node => node.disabled = busy || !state.revision);
  if (typeof updateStudio === 'function') updateStudio();
  if (canUse && hasUser && state.loginIntent === 'playlists' && !$('modal-login').open) {
    state.loginIntent = ''; queueMicrotask(openPlaylistPicker);
  }
}
function renderRows() {
  const fragment = document.createDocumentFragment();
  state.rows.forEach((row, index) => {
    const chosen = row.candidates.find(candidate => candidate.id === state.choices[index]);
    const isSkipped = state.skipped.has(index);
    const item = element('li', 'track-item' + (isSkipped ? ' skipped' : ''));
    item.append(element('span', 'track-index', String(index + 1).padStart(2, '0')));
    const checkbox = element('input', 'track-checkbox'); checkbox.type = 'checkbox'; checkbox.checked = !!chosen; checkbox.setAttribute('aria-label', '选择 ' + originalText(row));
    checkbox.disabled = locked() || !state.revision;
    checkbox.addEventListener('change', () => {
      revokeConfirm();
      if (!checkbox.checked) { state.remembered[index] = state.choices[index]; state.choices[index] = ''; state.skipped.add(index); }
      else if (state.remembered[index]) { state.choices[index] = state.remembered[index]; state.skipped.delete(index); }
      else { checkbox.checked = false; openCandidates(index); return; }
      renderRows();
    });
    item.append(checkbox);
    if (chosen?.cover && isCover(chosen.cover)) {
      const cover = element('img', 'track-cover'); cover.src = chosen.cover; cover.alt = ''; cover.loading = 'lazy'; item.append(cover);
    } else { const cover = element('span', 'track-cover track-cover-placeholder'); cover.setAttribute('aria-hidden', 'true'); cover.title = '暂无专辑封面'; item.append(cover); }
    const content = element('div', 'track-content');
    if (chosen && (chosen.title !== row.title || chosen.artist !== row.artist)) content.append(element('div', 'track-original', '原列表 · ' + originalText(row)));
    const title = element('div', 'track-main-info', chosen ? chosen.title : row.title);
    title.append(element('span', 'track-artist', ' · ' + (chosen ? chosen.artist : row.artist || '未指定歌手')));
    content.append(title);
    const meta = element('div', 'track-meta');
    meta.append(element('span', '', chosen ? chosen.album || '专辑未提供' : isSkipped ? '本次跳过' : row.candidates.length ? `找到 ${row.candidates.length} 个候选，请选择录音版本` : '曲库未找到，请检查歌名与歌手'));
    if (chosen) meta.append(element('span', '', formatDuration(chosen.duration)));
    if(chosen?.externalUrl)meta.append(sourceLink(chosen.externalUrl));
    content.append(meta); item.append(content);
    item.append(element('span', 'track-score-badge' + (chosen ? ' high' : !row.candidates.length ? ' error' : ''), chosen ? '已选' : isSkipped ? '已跳过' : row.candidates.length ? '待选版本' : '未找到'));
    const actions = element('div', 'track-actions');
    if (row.candidates.length) {
      const change = element('button', 'text-btn', chosen ? '换版本' : '选版本'); change.setAttribute('aria-label', (chosen ? '更换版本：' : '选择版本：') + row.title);
      change.addEventListener('click', () => openCandidates(index)); actions.append(change);
      const skip = element('button', 'text-btn skip-btn', isSkipped ? '恢复' : '跳过'); skip.setAttribute('aria-label', (isSkipped ? '恢复：' : '跳过：') + row.title);
      skip.addEventListener('click', () => {
        revokeConfirm();
        if (isSkipped) {
          state.skipped.delete(index);
          if (state.remembered[index]) state.choices[index] = state.remembered[index];
          else { renderRows(); openCandidates(index); return; }
        } else { state.remembered[index] = state.choices[index]; state.choices[index] = ''; state.skipped.add(index); }
        renderRows();
      }); actions.append(skip);
    }
    item.append(actions); fragment.append(item);
  });
  $('track-list').replaceChildren(fragment);
  toggle('track-list', !!state.rows.length); toggle('empty-state', !state.rows.length); toggle('results-stats', !!state.rows.length);
  sync();
}
function formatDuration(ms) { return ms > 0 ? `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}` : '时长未提供'; }
function openCandidates(index) {
  if (locked() || !state.revision) return;
  const row = state.rows[index];
  if (!row?.candidates.length) return;
  state.candidateIndex = index; state.candidateId = state.choices[index] || '';
  $('candidate-original-text').textContent = '正在核对 · ' + originalText(row);
  const fragment = document.createDocumentFragment();
  row.candidates.forEach(candidate => {
    const label = element('label', 'candidate-option');
    const radio = element('input'); radio.type = 'radio'; radio.name = 'candidate-version'; radio.value = candidate.id; radio.checked = candidate.id === state.candidateId;
    radio.addEventListener('change', () => { state.candidateId = candidate.id; sync(); });
    const meta = element('div', 'candidate-meta');
    meta.append(element('div', 'candidate-title', candidate.title));
    meta.append(element('div', 'candidate-desc', `${candidate.artist || '未知歌手'} · ${candidate.album || '专辑未提供'}`));
    meta.append(element('div', 'candidate-desc', `${formatDuration(candidate.duration)} · 排序分 ${candidate.score} · ID ${candidate.id}`));
    if (candidate.variantMismatch) meta.append(element('div', 'candidate-warning', '版本标记不同：请留意现场、混音、翻唱等差异'));
    if (candidate.writeBlocked) meta.append(element('div', 'candidate-warning', '类型信息不一致，暂不能导入；可跳过或重新匹配。'));
    if(candidate.externalUrl)meta.append(sourceLink(candidate.externalUrl));
    label.append(radio, meta); fragment.append(label);
  });
  $('candidate-list').replaceChildren(fragment); sync(); $('modal-candidates').showModal();
}
function updateProgress(job) {
  toggle('progress-zone', true);
  $('progress-label').textContent = job.state === 'matching' ? (state.demo ? '模拟曲库搜索' : '正在逐首搜索') : (state.demo ? '模拟追加与读回核验' : '正在追加并读回核验');
  $('progress-count').textContent = `${job.done || 0} / ${job.total || 0}`;
  $('progress-bar').max = Math.max(1, job.total || 0); $('progress-bar').value = job.done || 0;
}
async function pollJob() {
  if (state.polling) return;
  state.polling = true; state.suspended = false; notice(); sync();
  try {
    while (true) {
      const job = await api('job');
      if (['matching', 'importing'].includes(job.state)) {
        state.phase = job.state; updateProgress(job);
        if (job.state === 'matching') { state.rows = job.rows || []; state.choices = state.rows.map(row => row.selected || ''); renderRows(); }
        else sync();
        await wait(1500); continue;
      }
      state.phase = 'idle'; toggle('progress-zone', false);
      if (job.state === 'matched') {
        let unavailableVersions = 0;
        state.rows = job.rows; state.choices = job.rows.map(row => { const preferred = state.requestedVersions.find(value => value.title === row.title && value.artist === row.artist); if (!preferred) return row.selected || ''; if (row.candidates.some(value => value.id === preferred.id)) return preferred.id; unavailableVersions++; return ''; }); state.remembered = [...state.choices]; state.skipped.clear(); state.revision = job.revision;
        renderRows(); toast(`已匹配 ${job.rows.length} 首，请核对录音版本。`);
        if (unavailableVersions) notice(`${unavailableVersions} 首此前选定的版本未在本次候选中出现，已留空，请重新核对。`);
      } else if (job.state === 'imported') {
        state.revision = ''; state.report = job.report; renderReport();
        if (typeof markAnalysisSourceChanged === 'function') markAnalysisSourceChanged(job.report.playlistId);
      } else if (job.state === 'error') {
        state.revision = ''; notice(job.error + ' 请先查看官方歌单；写入操作不会自动重试。');
      } else { state.revision = ''; notice('没有可继续的任务，请重新匹配。'); }
      return;
    }
  } catch (error) {
    state.suspended = true;
    notice(`进度读取中断：${error.message} 当前任务可能仍在运行。可继续查看进度，导入不会被重复发送。`);
  } finally { state.polling = false; sync(); }
}
function renderReport() {
  const report = state.report;
  revokeConfirm();
  $('result-kicker').textContent = state.demo ? '模拟结果' : report.unverified.length ? '需要核对' : '导入完成';
  $('result-title').textContent = state.demo ? '模拟导入完成' : report.unverified.length ? '操作已停止，请核对歌单' : '导入已核验';
  $('result-symbol').textContent = report.unverified.length ? '!' : '✓';
  $('result-description').textContent = (state.demo ? '模拟歌单 · ' : '') + report.playlistName + (state.demo ? '（未连接音乐平台）' : '');
  $('result-added').textContent = report.verified.length; $('result-skipped').textContent = report.skipped.length; $('result-unverified').textContent = report.unverified.length;
  $('result-stopped').textContent = report.stopped ? report.stopped + ' 未确认的歌曲可能已经加入，也可能尚未尝试；请到官方客户端核对。' : '';
  toggle('result-stopped', !!report.stopped);
  const validLink = !state.demo && !!targetId(report.playlistId);
  if (validLink) $('result-link').href = playlistLink(report.playlistId);
  toggle('result-link', validLink); toggle('btn-copy-link', validLink); toggle('result-zone', true); sync();
  $('result-zone').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'nearest' });
}
function setTarget(id, name = '') {
  revokeConfirm(); $('input-target').value = String(id); $('selected-playlist-name').textContent = name || '歌单 ID · ' + id; sync();
}
async function loadPlaylists() {
  $('user-playlists').replaceChildren(element('li', 'text-hint', '正在读取你的歌单…'));
  const result = await api('playlists');
  const fragment = document.createDocumentFragment();
  for (const playlist of result.playlists) {
    const item = element('li'); const button = element('button', 'playlist-item');
    button.append(element('strong', '', playlist.name), element('span', '', `${playlist.count===null?'数量待读取':playlist.count+' 首'} · ${playlist.id}`));
    button.addEventListener('click', () => { if (locked()) return; setTarget(playlist.id, playlist.name); $('modal-playlists').close(); toast('目标歌单已选择。'); });
    item.append(button);if(state.platform==='spotify')item.append(sourceLink(playlistLink(playlist.id),'打开歌单 ↗'));fragment.append(item);
  }
  if (!result.playlists.length) fragment.append(element('li', 'text-hint', state.capabilities.create===false?'暂未找到可编辑歌单，请在官方客户端创建后刷新。':'暂未找到自己创建的歌单，可以在下方新建。'));
  $('user-playlists').replaceChildren(fragment);
}
function download(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = element('a'); anchor.href = url; anchor.download = name; document.body.append(anchor); anchor.click(); anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function sample() {
  if (locked()) return;
  $('input-order').value = 'title-first';
  $('input-tracks').value = "That's Enough for Me — Patti Austin\nIf I Ain't Got You — Alicia Keys\nSo Sick — Ne-Yo";
  resetPlan(); $('input-tracks').focus();
}

$('input-tracks').addEventListener('input', resetPlan);
$('input-order').addEventListener('change', resetPlan);
$('input-target').addEventListener('input', () => { revokeConfirm(); const id = targetId($('input-target').value); $('selected-playlist-name').textContent = id ? '歌单 ID · ' + id : '选择我的歌单'; sync(); });
$('btn-sample').addEventListener('click', sample); $('btn-empty-sample').addEventListener('click', sample);
$('btn-match').addEventListener('click', () => run(async () => {
  const preferred = state.requestedVersions; resetPlan(); state.requestedVersions = preferred; await api('match', { text: $('input-tracks').value, order: $('input-order').value });
  state.phase = 'matching'; sync(); await pollJob();
}));
$('btn-resume').addEventListener('click', () => { if (!state.pending && !state.polling) void pollJob(); });
$('btn-confirm-candidate').addEventListener('click', () => {
  if (locked() || !state.revision || !state.candidateId) return;
  const index = state.candidateIndex;
  if (!state.rows[index]?.candidates.some(candidate => candidate.id === state.candidateId)) return;
  revokeConfirm(); state.choices[index] = state.candidateId; state.remembered[index] = state.candidateId; state.skipped.delete(index);
  $('modal-candidates').close(); renderRows(); toast('已更新录音版本。');
});
$('btn-login-modal').addEventListener('click', () => { toggle('login-error', false); if (state.capabilities.qr !== false) selectLoginTab('qr'); $('modal-login').showModal(); if (state.capabilities.qr !== false && !state.qrReady && !state.session.hasSession) $('btn-generate-qr').click(); });
$('btn-oauth-save').addEventListener('click',()=>run(async()=>{
  const credential=$('input-oauth-credential').value.trim();$('input-oauth-credential').value='';
  const data=state.platform==='spotify'?{clientId:credential}:{developerToken:credential,storefront:$('input-oauth-storefront').value.trim()};
  const result=await api('oauth/config',data);state.session=result.session;state.user=null;resetPlan();toggle('oauth-authorize-link',false);if(typeof clearAnalysisSource==='function')clearAnalysisSource();toast('本次配置已保存。');
},'login-error'));
$('btn-oauth-open').addEventListener('click',()=>run(async()=>{
  const result=await api('oauth/start'),u=new URL(result.authorizeUrl);
  if(state.platform==='spotify'?u.origin!=='https://accounts.spotify.com'||u.pathname!=='/authorize':u.origin!==location.origin||u.pathname!=='/apple-auth.html')throw new Error('授权入口地址不正确，已停止。');
  $('oauth-authorize-link').href=u.href;toggle('oauth-authorize-link',true);resetPlan();
},'login-error'));
$('btn-oauth-check').addEventListener('click',()=>run(async()=>{
  const result=await api('session/verify');state.user=result.user;state.session=result.session;resetPlan();$('modal-login').close();if(typeof clearAnalysisSource==='function')clearAnalysisSource();toast(platformName()+'已连接。');
},'login-error'));
$('input-privacy').addEventListener('change', sync);
$('music-platform').addEventListener('change', () => {
  const next = $('music-platform').value;
  if (locked()) { sync(); return; }
  void run(async () => {
    stopQrPolling(); state.qrReady = false; state.qqQrType = 'qq'; state.loginIntent = ''; const previousPlatform=state.platform;
    const result = await api('platform', { platform: next });
    state.platform = result.platform; state.platforms = result.platforms; state.capabilities = result.capabilities; state.user = result.user; state.session = result.session; state.qrReady = false; state.phase = 'idle';
    $('input-cookie').value = ''; $('input-target').value = ''; $('qr-container').textContent = '点击下方生成二维码'; resetPlan();
    $('input-oauth-credential').value='';$('oauth-authorize-link').removeAttribute?.('href');toggle('oauth-authorize-link',false);if(previousPlatform==='spotify')$('input-tracks').value='';
    if (state.demo) setTarget('90001', platformName() + '演示歌单');
    if (typeof resetStudioPlatform === 'function') await resetStudioPlatform();
    toast('已切换至' + platformName() + '，请重新选择目标和匹配歌曲。');
  });
});
document.querySelectorAll('.btn-close-modal').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('modal-confirm').addEventListener('close', () => { state.confirm = null; sync(); });
function selectLoginTab(name) {
  document.querySelectorAll('.tab-btn').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  toggle('login-tab-qr', name === 'qr'); toggle('login-tab-cookie', name === 'cookie');
}
function stopQrPolling() { if (qrTimer) clearTimeout(qrTimer); qrTimer = null; qrEpoch++; }
function cancelQQQR() {
  stopQrPolling();
  if (state.capabilities.autoQr === true) { state.qrReady = false; return api('qr/cancel').catch(() => {}); }
  return Promise.resolve();
}
$('modal-login').addEventListener('close', () => { if (!state.user) state.loginIntent = ''; void cancelQQQR(); });
document.querySelectorAll('.tab-btn').forEach(button => button.addEventListener('click', async () => {
  if (locked() && !state.qrWorking || qrSwitching) return;
  document.querySelectorAll('.tab-btn').forEach(tab => tab.classList.toggle('active', tab === button));
  toggle('login-tab-qr', button.dataset.tab === 'qr'); toggle('login-tab-cookie', button.dataset.tab === 'cookie');
  if (button.dataset.tab === 'cookie') { const pending = qrWork; await cancelQQQR(); if (pending) await pending; sync(); }
  else if (!state.qrReady && !state.session.hasSession) $('btn-generate-qr').click();
}));
['qq','wx'].forEach(type => $('btn-qr-' + type).addEventListener('click', async () => {
  if (locked() && !state.qrWorking || qrSwitching || state.qqQrType === type) return;
  qrSwitching = true; sync();
  try { const pending = qrWork; await cancelQQQR(); if (pending) await pending; state.qqQrType = type; state.qrReady = false; await generateQr(); }
  finally { qrSwitching = false; sync(); }
}));
function startQrWork(action) {
  if (locked()) return Promise.resolve();
  state.qrWorking = true;
  qrWork = run(action, 'login-error').finally(() => { state.qrWorking = false; sync(); });
  return qrWork;
}
function scheduleQrPoll() {
  if (qrTimer) clearTimeout(qrTimer);
  if (!state.capabilities.autoQr || !state.qrReady || !$('modal-login').open) return;
  const epoch = qrEpoch;
  qrTimer = setTimeout(async () => {
    qrTimer = null;
    if (epoch !== qrEpoch || !state.qrReady || !$('modal-login').open) return;
    if (Date.now() >= state.qrExpires) { cancelQQQR(); $('qr-status').textContent = '二维码已过期，点击生成新的二维码。'; sync(); return; }
    if (locked() || document.hidden) { scheduleQrPoll(); return; }
    await checkQr();
  }, 3500);
}
async function generateQr() { return startQrWork(async () => {
  stopQrPolling(); const epoch = qrEpoch;
  state.qrReady = false; $('qr-status').textContent = '正在生成二维码…';
  $('qr-container').textContent = '正在连接官方登录服务…';
  let result; try { result = await api('qr', { type: state.platform === 'qq' ? state.qqQrType : undefined }); }
  catch (error) { if (epoch !== qrEpoch) return; $('qr-status').textContent = '二维码生成失败，可重新生成或尝试备用登录。'; throw error; }
  if (epoch !== qrEpoch) return;
  if (!/^data:image\/(png|jpeg|webp);base64,/.test(result.image)) throw new Error('服务未返回有效二维码。');
  const image = element('img'); image.src = result.image; image.alt = platformName() + '登录二维码'; $('qr-container').replaceChildren(image);
  state.qrReady = true; state.qrExpires = result.expiresAt || Date.now() + 180000; state.nextQrCheck = 0;
  $('qr-status').textContent = state.platform === 'qq' ? (state.qqQrType === 'wx' ? '用微信扫一扫，随后在手机确认。' : '用手机 QQ 扫一扫，随后在手机确认。') : '用网易云 App 扫码并确认，再检查状态。';
  scheduleQrPoll();
}); }
$('btn-generate-qr').addEventListener('click', generateQr);
async function checkQr() { return startQrWork(async () => {
  const epoch = qrEpoch;
  state.nextQrCheck = Date.now() + 3000; setTimeout(sync, 3100);
  let result; try { result = await api('qr/check'); }
  catch (error) { if (epoch !== qrEpoch) return; stopQrPolling(); state.qrReady = false; $('qr-status').textContent = '检测已停止，请检查提示后重新生成。'; throw error; }
  if (epoch !== qrEpoch) return;
  $('qr-status').textContent = ({ 800: '二维码已过期，请重新生成。', 801: '等待扫码。', 802: '已扫码，请在手机确认。', 803: '已完成扫码确认。', 804: '手机已取消授权，可重新生成。' })[result.code] || '状态未知，请查看官方客户端。';
  if ([800,804].includes(result.code)) { state.qrReady = false; stopQrPolling(); }
  if (result.authorized) {
    state.user = result.user; state.session = { hasSession: true, verified: !!result.user, source: 'qr' }; state.qrReady = false; resetPlan();
    if (typeof clearAnalysisSource === 'function') clearAnalysisSource();
    if (result.user) { $('modal-login').close(); toast(platformName() + '已连接。'); }
    else { $('qr-status').textContent = '手机授权已完成；账号验证待完成。'; $('login-error').textContent = result.warning; toggle('login-error', true); }
  } else if (result.user) { state.user = result.user; state.qrReady = false; resetPlan(); $('modal-login').close(); toast(platformName() + '已连接。'); }
  if ([801,802].includes(result.code)) scheduleQrPoll();
}); }
$('btn-check-qr').addEventListener('click', checkQr);
$('btn-verify-session').addEventListener('click', () => run(async () => {
  const result = await api('session/verify'); state.user = result.user; state.session = result.session; resetPlan(); $('modal-login').close(); toast('账号验证完成。');
}, 'login-error'));
$('btn-submit-cookie').addEventListener('click', () => run(async () => {
  const cookie = $('input-cookie').value; $('input-cookie').value = '';
  const result = await api('cookie', { cookie }); state.user = result.user; state.session = { hasSession: true, verified: true, source: 'cookie' }; resetPlan(); $('modal-login').close(); toast('已验证本地登录。');
  if (typeof clearAnalysisSource === 'function') clearAnalysisSource();
}, 'login-error'));
$('btn-clear-login').addEventListener('click', () => run(async () => {
  await api('clear'); state.user = null; state.session = {}; state.qrReady = false; $('input-cookie').value = ''; $('qr-container').textContent = '点击下方生成二维码'; $('input-target').value = ''; resetPlan(); $('modal-login').close(); toast('已清除本工具会话。');
  if (typeof clearAnalysisSource === 'function') clearAnalysisSource();
}, 'login-error'));
async function openPlaylistPicker() {
  if (locked() || !state.connected) return;
  if (!state.user) { state.loginIntent = 'playlists'; $('btn-login-modal').click(); return; }
  $('modal-playlists').showModal(); await run(loadPlaylists, 'playlist-error');
}
$('btn-select-playlist').addEventListener('click', openPlaylistPicker);
$('btn-refresh-playlists').addEventListener('click', () => run(loadPlaylists, 'playlist-error'));
$('btn-create-playlist').addEventListener('click', () => run(async () => {
  const name = $('input-new-playlist').value.trim(); if (!name) throw new Error('请填写新歌单名称。');
  const result = await api('create', { confirm: true, name, privacy: $('input-privacy').value });
  setTarget(result.id, result.name); $('input-new-playlist').value = ''; $('modal-playlists').close(); toast(state.demo ? '已创建模拟歌单。' : '已创建并选择歌单。');
}, 'playlist-error'));
$('btn-execute-import').addEventListener('click', () => {
  if (locked() || !state.revision || !uniqueCount()) return;
  const target = targetId($('input-target').value); if (!target) return;
  state.confirm = { revision: state.revision, target, selections: [...state.choices] };
  $('confirm-description').textContent = `将 ${uniqueCount()} 首歌曲追加到「${$('selected-playlist-name').textContent}」（ID ${target}）。`;
  toggle('confirm-demo', state.demo); sync(); $('modal-confirm').showModal();
});
$('btn-confirm-import').addEventListener('click', () => run(async () => {
  const snapshot = state.confirm;
  if (!snapshot || snapshot.revision !== state.revision || snapshot.target !== targetId($('input-target').value) || JSON.stringify(snapshot.selections) !== JSON.stringify(state.choices)) throw new Error('核对内容已变化，请重新确认。');
  // Consume the confirmation before dispatch. Never automatically resend a write.
  state.confirm = null; $('modal-confirm').close(); state.revision = '';
  state.phase = 'importing'; sync();
  try { await api('import', { ...snapshot, confirm: true }); }
  catch (error) { state.phase = 'idle'; throw new Error(error.message + ' 请先查看官方歌单，重新匹配后再操作。'); }
  await pollJob();
}));
$('btn-export-text').addEventListener('click', () => {
  const seen = new Set();
  const lines = state.rows.flatMap((row, index) => { const candidate = row.candidates.find(item => item.id === state.choices[index]); if (!candidate || seen.has(candidate.id)) return []; seen.add(candidate.id); return [candidate.title + ' — ' + candidate.artist]; });
  download('歌单接力-已选歌曲.txt', lines.join('\n'), 'text/plain;charset=utf-8');
});
$('btn-export-report').addEventListener('click', () => { if (state.report) download('歌单接力-核对记录.json', JSON.stringify({ ...state.report, demo: state.demo }, null, 2), 'application/json;charset=utf-8'); });
$('btn-copy-link').addEventListener('click', async () => {
  if (!state.report || state.demo) return;
  const link = playlistLink(state.report.playlistId);
  try { await navigator.clipboard.writeText(link); toast('已复制' + platformName() + '歌单链接。'); }
  catch { notice('浏览器未允许复制，可从“打开歌单”获取链接。'); }
});

const platformReady = (async () => {
  state.pending = true;
  sync();
  try {
    const result = await api('status'); state.connected = true; state.demo = result.demo; state.user = result.user; state.session = result.session || {}; state.platform = result.platform || 'netease'; state.platforms = result.platforms || ['netease']; state.capabilities = result.capabilities || state.capabilities;
    if (state.demo) setTarget('90001', '演示歌单'); else if (state.user) $('selected-playlist-name').textContent = '选择我的歌单';
    const job = await api('job');
    if (job.state !== 'idle') { state.phase = ['matching', 'importing'].includes(job.state) ? job.state : 'idle'; await pollJob(); }
  } catch (error) { notice(error.message); }
  finally { state.pending = false; sync(); }
})();
