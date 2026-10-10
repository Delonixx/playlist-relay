'use strict';
// Uses the existing local API helper; all external model calls happen server-side.
const studio = { ready: false, page: 'playlist', configured: false, demo: false, aiBusy: false, polling: false, suspended: false, playlist: null, result: null, selection: new Set(), activeSignature: '', signature: '', settingsBusy: false, providers: [], provider: 'zhipu', model: '', recRows: new Map(), recChoices: new Map(), recVersionIndex: -1, recVersionId: '', readBusy: false, readError: '', jobKind: 'analysis', progress: null };
studio.queue = new Map(); studio.feedback = []; studio.feedbackLoaded = false; studio.feedbackMemoryOnly = false; studio.feedbackSupported = false;
const tasteLabels = { like: '喜欢', less: '少推荐', heard: '听过' };
const trackKey = value => [value.title, value.artist].map(text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')).join('\0');
function cleanTasteRecords(input) {
  const rows = new Map();
  for (const value of (Array.isArray(input) ? input : []).slice(-200)) {
    if (!Object.hasOwn(tasteLabels, value?.mark) || typeof value.title !== 'string' || typeof value.artist !== 'string') continue;
    const title = value.title.trim().slice(0,160), artist = value.artist.trim().slice(0,160);
    if (!title || !artist) continue;
    const key = trackKey({ title, artist }); rows.delete(key); rows.set(key, { title, artist, mark: value.mark });
  }
  return [...rows.values()];
}
const tasteStorageKey = () => 'playlist-relay-taste-v1' + (studio.demo ? '-demo' : '');
function loadTasteRecords() {
  try { studio.feedback = cleanTasteRecords(JSON.parse(globalThis.localStorage.getItem(tasteStorageKey()) || '[]')); }
  catch { studio.feedback = []; studio.feedbackMemoryOnly = true; }
  studio.feedbackLoaded = true;
}
function saveTasteRecords() {
  try {
    if (studio.feedback.length) globalThis.localStorage.setItem(tasteStorageKey(), JSON.stringify(studio.feedback));
    else globalThis.localStorage.removeItem(tasteStorageKey());
    studio.feedbackMemoryOnly = false;
  } catch { studio.feedbackMemoryOnly = true; }
}
function setTasteFeedback(value, mark) {
  if (studio.aiBusy || locked()) return;
  if (!studio.feedbackSupported) { toast('当前运行的是旧服务，更新并重启后才能使用口味反馈。'); return; }
  const key = trackKey(value), old = studio.feedback.find(row => trackKey(row) === key);
  studio.feedback = studio.feedback.filter(row => trackKey(row) !== key);
  if (old?.mark !== mark) studio.feedback.push({ title: value.title, artist: value.artist, mark });
  studio.feedback = cleanTasteRecords(studio.feedback); saveTasteRecords();
  if (mark === 'less' && old?.mark !== mark) studio.queue.delete(key);
  recommendationSettingsChanged(); renderRecommendations();
  toast(old?.mark === mark ? '已撤销这条反馈。' : mark === 'heard' ? '已记为听过，下次不重复推荐这首。' : '已记录，下次生成推荐时使用。');
}
function renderTasteRecords() {
  $('taste-storage-note').textContent = !studio.feedbackSupported ? '当前仍在运行旧服务，暂不支持口味反馈。更新并重启服务后可以使用；现有记录会保留。' : studio.feedbackMemoryOnly ? '浏览器未能保存；本次页面仍可使用，刷新后可能丢失。' : studio.demo ? '演示记录单独保存在此浏览器，不影响正式使用。' : '只在此浏览器保存歌曲与标记，最多 200 条。生成推荐时发送给所选 AI；不包含登录信息或 Key。';
  $('taste-records').replaceChildren(...[...studio.feedback].reverse().map(value => {
    const item = element('li', 'taste-record');
    const detail = element('div'); detail.append(element('strong', '', value.title), element('p', '', value.artist));
    const mark = element('span', 'taste-record-mark', tasteLabels[value.mark]);
    const undo = element('button', 'text-btn', '撤销'); undo.setAttribute('aria-label', '撤销反馈：' + value.title); undo.disabled = studio.aiBusy || locked();
    undo.addEventListener('click', () => { setTasteFeedback(value, value.mark); renderTasteRecords(); }); item.append(detail, mark, undo); return item;
  }));
  toggle('taste-empty', !studio.feedback.length); $('btn-clear-taste').disabled = !studio.feedback.length || studio.aiBusy || locked();
}
const analysisLimit = () => [40,100,200].includes(Number($('analysis-limit').value)) ? Number($('analysis-limit').value) : 200;
const recommendationDirection = () => ['familiar','expand','adventurous'].includes($('analysis-direction').value) ? $('analysis-direction').value : 'expand';
const recommendationPreferences = () => $('discover-preferences').value.trim();
const recommendationSignature = () => JSON.stringify({ direction: recommendationDirection(), preferences: recommendationPreferences(), feedback: studio.feedback });
studio.recFailure = '';
const directionLabels = { familiar: '贴近口味', expand: '向外延伸', adventurous: '尝试跨界' };

function studioPage(name) {
  if (!['playlist', 'analysis', 'discover'].includes(name)) return;
  const changed = studio.page !== name;
  studio.page = name;
  for (const page of ['playlist', 'analysis', 'discover']) toggle('page-' + page, page === name);
  document.querySelectorAll('.nav-item').forEach(button => { button.classList.toggle('active', button.dataset.page === name); button.setAttribute('aria-current', button.dataset.page === name ? 'page' : 'false'); });
  document.title = '歌单接力 · ' + ({ playlist: '歌单', analysis: '分析', discover: '发现' })[name];
  updateStudio();
  if (changed) document.scrollingElement?.scrollTo({ top: 0, behavior: 'auto' });
}
function analysisData() {
  const options = { tone: $('analysis-tone').value, limit: analysisLimit() };
  if ($('analysis-source').value === 'playlist') {
    if (!studio.playlist) throw new Error('先读取一个目标歌单，或切换到“当前歌曲”。');
    return { ...options, tracks: studio.playlist.tracks, title: studio.playlist.title, total: studio.playlist.total, sampled: studio.playlist.sampled };
  }
  if (state.rows.length) {
    const tracks = state.rows.flatMap((row, index) => { const candidate = row.candidates.find(value => value.id === state.choices[index]); return candidate ? [{ title: candidate.title, artist: candidate.artist, album: candidate.album, year: candidate.year }] : []; });
    if (!tracks.length) throw new Error('先选定至少一首歌曲。');
    return { ...options, tracks, title: '当前选曲' };
  }
  if (!$('input-tracks').value.trim()) throw new Error('先粘贴歌曲列表，或读取已有歌单。');
  return { ...options, text: $('input-tracks').value, order: $('input-order').value, title: '当前歌曲' };
}
function dataSignature(data) { return JSON.stringify({ tracks: data.tracks || null, text: data.text || null, order: data.order || null, title: data.title, tone: data.tone, limit: data.limit }); }
function sourceTracks() {
  if ($('analysis-source').value === 'playlist') return studio.playlist?.tracks || [];
  if (state.rows.length) return state.rows.flatMap((row, index) => { const chosen = row.candidates.find(value => value.id === state.choices[index]); return chosen ? [chosen] : []; });
  return $('input-tracks').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(title => ({ title, artist: '' }));
}
function clearAnalysisSource() {
  studio.playlist = null; studio.readError = ''; $('analysis-source').value = 'current'; updateStudio();
}
async function resetStudioPlatform() {
  studio.aiBusy = false; studio.result = null; studio.signature = ''; studio.activeSignature = ''; studio.selection.clear(); studio.queue.clear(); studio.recRows.clear(); studio.recChoices.clear(); clearAnalysisSource();
  toggle('analysis-report', false); toggle('analysis-empty', true); toggle('ai-progress', false); aiError(); renderRecommendations();
  applyAIStatus(await api('ai/status')); updateStudio();
}
function markAnalysisSourceChanged(target) {
  if (studio.playlist && String(studio.playlist.id) === String(target)) studio.playlist.needsRefresh = true;
  updateStudio();
}
function updateStudio() {
  const busy = locked();
  $('music-platform').disabled = busy || !state.connected || state.platforms.length < 2 || studio.aiBusy;
  ['btn-go-analysis', 'btn-toggle-input', 'btn-ai-settings'].forEach(id => $(id).disabled = !state.connected);
  ['btn-read-playlist', 'btn-read-from-playlist'].forEach(id => $(id).disabled = !state.connected || busy || studio.aiBusy);
  $('btn-read-playlist').textContent = targetId($('input-target').value) ? '读取目标歌单' : '选择来源歌单';
  $('btn-read-from-playlist').textContent = targetId($('input-target').value) ? '读取歌单用于分析' : '选择歌单用于分析';
  ['btn-analyze', 'btn-analyze-empty'].forEach(id => $(id).disabled = !state.connected || busy || studio.aiBusy);
  $('btn-new-recommendations').disabled = !state.connected || busy || studio.aiBusy || !studio.result;
  const aiBlocked=state.capabilities.aiAnalysis===false;
  ['btn-analyze','btn-analyze-empty','btn-new-recommendations','btn-read-playlist','btn-read-from-playlist'].forEach(id=>$(id).disabled ||= aiBlocked);
  toggle('global-ai-note',aiBlocked);$('global-ai-note').textContent=state.capabilities.aiReason||'';
  $('btn-ai-resume').disabled = studio.polling;
  $('btn-match-recommendations').disabled = busy || studio.aiBusy || !studio.queue.size;
  $('btn-match-recommendations').textContent = studio.queue.size ? `核对待选 · ${studio.queue.size}` : '匹配所选歌曲';
  $('btn-queue-match').disabled = busy || studio.aiBusy || !studio.queue.size;
  $('btn-open-queue').textContent = `查看待选 · ${studio.queue.size} 首`;
  $('queue-count').textContent = `${studio.queue.size} 首待选`;
  toggle('recommendation-queue', !!studio.queue.size);
  $('btn-clear-queue').disabled = busy || studio.aiBusy || !studio.queue.size;
  $('btn-taste-records').textContent = `口味记录 · ${studio.feedback.length}`;
  $('btn-taste-records').disabled = studio.aiBusy || busy;
  $('btn-export-analysis').disabled = !studio.result;
  $('btn-save-ai-key').disabled = !state.connected || studio.demo || studio.settingsBusy || !studio.providers.length;
  $('btn-clear-ai-key').disabled = !state.connected || studio.demo || studio.settingsBusy || !studio.providers.find(value => value.id === $('ai-provider').value)?.configured;
  $('btn-clear-all-ai').disabled = !state.connected || studio.demo || studio.settingsBusy || !studio.providers.some(value => value.configured);
  $('ai-provider').disabled = studio.settingsBusy; $('ai-model').disabled = studio.settingsBusy;
  $('input-ai-key').disabled = studio.demo || studio.settingsBusy;
  $('ai-connection-dot').classList.toggle('connected', studio.configured);
  const selectedProvider = studio.providers.find(value => value.id === $('ai-provider').value);
  $('ai-key-status').textContent = studio.demo ? '离线演示使用示例数据，不接收 Key。' : selectedProvider?.configured ? '本次会话已有此服务的 Key；留空可继续使用，填写新 Key 可替换。' : '尚未配置所选服务的 Key。';
  const title = $('analysis-source').value === 'playlist' && studio.playlist ? studio.playlist.title : '当前歌曲';
  const count = $('analysis-source').value === 'playlist' && studio.playlist ? studio.playlist.tracks.length : state.rows.length ? selectedCount() : $('input-tracks').value.split(/\r?\n/).filter(value => value.trim()).length;
  const fromPlaylist = $('analysis-source').value === 'playlist' && !!studio.playlist;
  const raw = !fromPlaylist && !state.rows.length;
  $('analysis-source-label').textContent = title + (count ? ` · ${count} ${raw ? '行' : '首'}` : '');
  const currentCount = state.rows.length ? selectedCount() : $('input-tracks').value.split(/\r?\n/).filter(value => value.trim()).length;
  $('analysis-current-option').textContent = (state.rows.length ? '本次选曲' : '输入列表') + ` · ${currentCount ? currentCount + (state.rows.length ? ' 首' : ' 行') : '未添加'}`;
  $('analysis-playlist-option').textContent = studio.playlist ? `${studio.playlist.title} · ${studio.playlist.tracks.length} 首` : '尚未读取歌单';
  $('analysis-playlist-option').disabled = !studio.playlist;
  $('analysis-source-kind').textContent = studio.readBusy ? '正在读取' : fromPlaylist ? platformName() + '歌单 · 已读取' : state.rows.length ? '已选定的曲目' : '输入列表';
  $('analysis-source-name').textContent = studio.readBusy ? $('selected-playlist-name').textContent : fromPlaylist ? title : count ? state.rows.length ? '本次选曲' : '歌曲列表' : '尚未添加歌曲';
  $('analysis-source-count').textContent = studio.readBusy ? '读取中…' : `${count} ${raw ? '行' : '首'}`;
  const limit = analysisLimit(), analyzeCount = Math.min(count, limit);
  $('analysis-source-detail').textContent = studio.readBusy ? '正在取得歌曲资料，完成后会显示实际数量。' : fromPlaylist ? `歌单共 ${studio.playlist.total} 首 · 已取得 ${count} 首资料 · 本次分析 ${analyzeCount} 首${count > limit ? ' · 均匀抽样' : ' · 全部已读取曲目'}` : count ? raw ? `分析前会解析、去重，最多分析 ${limit} 首。` : `已选 ${count} 首 · 本次分析 ${analyzeCount} 首` : '粘贴歌曲列表，或选择并读取' + platformName() + '歌单。';
  $('analysis-call-estimate').textContent = count ? `分批分析 ${analyzeCount} 首 · 预计 ${analyzeCount <= 32 ? 1 : Math.ceil(analyzeCount / 32) + 1} 次模型请求${raw ? '，实际以解析去重后为准' : ''}。换推荐方向只需 1 次请求。` : '';
  const changedTarget = fromPlaylist && String(studio.playlist.id) !== targetId($('input-target').value);
  const warning = studio.readError ? '读取未完成：' + studio.readError : changedTarget ? `目标歌单已改变；分析来源仍是「${studio.playlist.title}」，请重新读取后再切换。` : fromPlaylist && studio.playlist.needsRefresh ? '此歌单已执行追加；这里是追加前的资料，请重新读取以更新数量和分析。' : fromPlaylist && studio.playlist.unavailable ? `${studio.playlist.unavailable} 首资料暂不可读取，已取得的歌曲可在“查看歌曲”中核对。` : '';
  $('analysis-source-warning').textContent = warning; toggle('analysis-source-warning', !!warning);
  $('btn-source-tracks').textContent = `查看 ${count} ${raw ? '行' : '首歌曲'}`;
  $('btn-source-tracks').disabled = !count || studio.readBusy;
  $('btn-source-picker').disabled = !state.connected || busy || studio.aiBusy;
  $('btn-source-picker').textContent = state.user ? '选择 / 更换歌单' : '登录并选择歌单';
  const nextAnalysisAction = !count ? '添加歌曲列表' : !studio.configured ? '配置 AI' : studio.aiBusy && studio.jobKind === 'analysis' ? '分析中…' : studio.result ? '重新分析' : '开始分析';
  ['btn-analyze', 'btn-analyze-empty'].forEach(id => { $(id).disabled = !state.connected || busy || studio.aiBusy || aiBlocked; $(id).textContent = aiBlocked ? '当前平台不支持分析' : nextAnalysisAction; });
  $('analysis-empty-description').textContent = !count ? '添加一份歌曲列表，或选择并读取已有歌单。' : !studio.configured ? `${count} ${raw ? '行' : '首歌曲'}已准备，配置 AI 后即可分析。` : `${count} ${raw ? '行' : '首歌曲'}已准备，可以开始分析。`;
  const recChanged = !!studio.result && (recommendationDirection() !== studio.result.direction || recommendationPreferences() !== studio.result.recommendationPreferences || studio.feedbackSupported && JSON.stringify(studio.feedback) !== JSON.stringify(studio.result.feedback || []));
  const recFailed = studio.recFailure === recommendationSignature();
  $('btn-new-recommendations').textContent = studio.aiBusy && studio.jobKind === 'recommendations' ? '生成中…' : recFailed ? '再生成一次' : recChanged ? '生成推荐' : '换一批';
  $('direction-description').textContent = ({ familiar: '保留相近的唱法、编排与律动，寻找新的作品。', expand: '保留一个喜欢的元素，向邻近流派、不同年代或地区延伸。', adventurous: '尝试不同流派家族，每首都说明连接点与差异。' })[recommendationDirection()];
  $('recommendation-stale').textContent = recChanged ? '新设置尚未应用到当前歌曲' : '';
  toggle('recommendation-stale', recChanged && !recFailed);
  ['analysis-direction','discover-preferences','analysis-limit','analysis-tone','analysis-source'].forEach(id => $(id).disabled = studio.aiBusy);
  ['btn-ai-cancel','btn-rec-cancel'].forEach(id => $(id).disabled = !studio.aiBusy);
  $('btn-analysis-ai').textContent = studio.demo ? 'AI · 离线示例' : studio.configured ? `AI · ${studio.providers.find(value => value.id === studio.provider)?.name || studio.provider}` : '配置 AI';
  $('btn-load-covers').disabled = busy || studio.aiBusy || !studio.result?.recommendations.length;
  $('btn-confirm-rec-version').disabled = busy || !studio.recVersionId;
  $('playlist-subtitle').textContent = state.rows.length ? `${state.rows.length} 首 · ${selectedCount()} 已选` : '文字导入与版本核对';
  if (studio.result) {
    let signature = ''; try { signature = dataSignature(analysisData()); } catch {}
    $('analysis-stale').textContent = `当前展示「${studio.result.source.title}」的分析结果。` + (studio.signature ? '来源或分析设置已变化，重新分析后更新。' : '这是上次的快照，选择来源后可重新分析。');
    toggle('analysis-stale', !studio.signature || signature !== studio.signature || !!(fromPlaylist && studio.playlist.needsRefresh));
  }
  document.querySelectorAll('.recommendation-card input').forEach(input => input.disabled = studio.aiBusy || busy);
  document.querySelectorAll('.rec-version-button').forEach(button => button.disabled = studio.aiBusy || busy);
  document.querySelectorAll('.queue-remove').forEach(button => button.disabled = studio.aiBusy || busy);
  document.querySelectorAll('.taste-button').forEach(button => { button.disabled = studio.aiBusy || busy || !studio.feedbackSupported; button.title = studio.feedbackSupported ? '下次生成推荐时使用，再点可撤销' : '当前服务版本较旧，请在口味记录中查看说明'; });
  $('btn-discover-analyze').textContent = studio.result ? '根据画像生成推荐' : '去分析';
  $('btn-discover-analyze').disabled = studio.aiBusy || busy || aiBlocked;
  $('discover-empty-description').textContent = aiBlocked ? state.capabilities.aiReason : studio.result ? '画像已保留，可以直接生成新推荐。' : '先分析一份歌单，再寻找新的作品。';
  toggle('btn-analysis-add-songs', !!count && !studio.configured);
}
function aiError(message = '') { const id = studio.jobKind === 'recommendations' ? 'discover-error' : 'ai-error'; $(id).textContent = message; toggle(id, !!message); }
function updateAIProgress() {
  const rec = studio.jobKind === 'recommendations', progress = studio.progress;
  toggle('ai-progress', studio.aiBusy && !rec); toggle('discover-progress', studio.aiBusy && rec);
  const text = studio.demo ? '正在载入离线示例…' : rec ? '正在生成新推荐，复用已完成的画像…' : progress?.stage === 'review' ? `已判断 ${progress.total} 首，正在汇总点评…` : progress ? `已判断 ${progress.done} / ${progress.total} 首，正在分析下一批…` : '正在分析歌曲资料…';
  $('ai-progress-text').textContent = text; $('discover-progress-text').textContent = text;
}
function applyAIStatus(result) {
  const demoChanged = studio.demo !== result.demo;
  studio.configured = result.configured; studio.demo = result.demo; studio.provider = result.provider || 'zhipu'; studio.model = result.model; studio.providers = result.providers || [];
  studio.feedbackSupported = result.supportsFeedback === true;
  if (!studio.feedbackLoaded || demoChanged) loadTasteRecords();
  $('ai-provider').replaceChildren(...studio.providers.map(value => { const option = element('option', '', value.name + (value.configured ? ' · 已配置' : '')); option.value = value.id; return option; }));
  $('ai-provider').value = studio.provider; fillProvider();
}
function fillProvider() {
  $('input-ai-key').value = ''; $('ai-confirm-cost').checked = false;
  const provider = studio.providers.find(value => value.id === $('ai-provider').value);
  $('ai-model').value = provider?.model || provider?.defaultModel || ''; updateProviderPricing(); updateStudio();
}
function updateProviderPricing() {
  const provider = studio.providers.find(value => value.id === $('ai-provider').value);
  $('ai-provider-pricing').textContent = provider?.pricing || '本地服务版本较旧，请停止旧服务后重新启动。';
  toggle('ai-cost-zone', !!provider && !(provider.id === 'zhipu' && $('ai-model').value === 'glm-4.7-flash'));
  $('ai-provider-privacy').textContent = provider ? `分析会将歌曲资料和偏好发送至${provider.name}。各服务 Key 分别保存在本机进程内存，关闭服务即清除。` : '';
  if (provider) { $('ai-key-link').href = provider.keyUrl; $('ai-docs-link').href = provider.docsUrl; }
}
function showSettings() { toggle('ai-settings-error', false); $('ai-provider').value = studio.provider; fillProvider(); $('modal-ai-settings').showModal(); }
async function configureAI(clear = false, clearAll = false) {
  if (studio.settingsBusy || studio.demo) return;
  const key = $('input-ai-key').value; $('input-ai-key').value = '';
  studio.settingsBusy = true; toggle('ai-settings-error', false); updateStudio();
  try {
    const provider = $('ai-provider').value;
    const result = await api('ai/config', clear || clearAll ? { clear: true, clearAll, provider } : { key, provider, model: $('ai-model').value.trim(), confirmCost: $('ai-confirm-cost').checked });
    applyAIStatus(result);
    studio.aiBusy = false; studio.result = null; studio.signature = ''; studio.selection.clear(); studio.recRows.clear(); studio.recChoices.clear(); toggle('analysis-report', false); toggle('analysis-empty', true); renderRecommendations();
    $('modal-ai-settings').close(); toast(clear || clearAll ? '已清除所选凭证与分析结果。' : '已切换 AI 服务，Key 保存在本次会话。');
  } catch (error) { $('ai-settings-error').textContent = error.message; toggle('ai-settings-error', true); }
  finally { studio.settingsBusy = false; updateStudio(); }
}
async function readForAnalysis() {
  if (locked() || studio.aiBusy) return;
  if (!targetId($('input-target').value)) { $('btn-select-playlist').click(); return; }
  studioPage('analysis'); aiError();
  await run(async () => {
    studio.readBusy = true; studio.readError = ''; updateStudio();
    try {
    const target = targetId($('input-target').value);
    if (!target) throw new Error('先选择目标歌单。');
    studio.playlist = await api('playlist/read', { target });
    $('analysis-source').value = 'playlist';
    toast(studio.playlist.sampled ? `歌单 ${studio.playlist.total} 首，均匀抽取 ${studio.playlist.tracks.length} 首分析。` : `已读取 ${studio.playlist.tracks.length} 首。`);
    if (studio.playlist.unavailable) aiError(`${studio.playlist.unavailable} 首曲目资料不可读取；将分析已取得的曲目。`);
    updateStudio();
    } catch (error) { studio.readError = error.message; throw error; }
    finally { studio.readBusy = false; updateStudio(); }
  });
}
async function startAnalysis() {
  if (studio.aiBusy || locked()) return;
  if (!sourceTracks().length) { $('btn-toggle-input').click(); return; }
  studioPage('analysis'); studio.jobKind = 'analysis'; aiError();
  if (!studio.configured) { showSettings(); return; }
  try {
    const data = analysisData();
    studio.jobKind = 'analysis'; studio.progress = null; studio.aiBusy = true; studio.activeSignature = dataSignature(data); updateStudio(); updateAIProgress();
    await api('ai/analyze', { ...data, direction: recommendationDirection(), recommendationPreferences: recommendationPreferences(), feedback: studio.feedback }); await pollAnalysis();
  } catch (error) { studio.aiBusy = false; toggle('ai-progress', false); aiError(error.message); updateStudio(); }
}
async function startRecommendations() {
  if (studio.aiBusy || locked() || !studio.result) return;
  studioPage('discover'); studio.jobKind = 'recommendations'; studio.recFailure = ''; aiError();
  if (!studio.configured) { showSettings(); return; }
  try {
    const snapshot = studio.result;
    studio.aiBusy = true; studio.progress = null; updateStudio(); updateAIProgress();
    await api('ai/recommend', { fingerprint: snapshot.source.fingerprint, direction: recommendationDirection(), preferences: recommendationPreferences(), feedback: studio.feedback });
    await pollAnalysis();
  } catch (error) { studio.aiBusy = false; updateAIProgress(); aiError(error.message); updateStudio(); }
}
async function cancelAI() {
  try { await api('ai/cancel'); studio.aiBusy = false; studio.suspended = false; updateAIProgress(); updateStudio(); toast('已停止任务，完成的画像会保留。'); }
  catch (error) { aiError(error.message); }
}
async function pollAnalysis() {
  if (studio.polling) return;
  studio.polling = true; studio.suspended = false; toggle('btn-ai-resume', false); toggle('btn-rec-resume', false); updateStudio();
  try {
    while (true) {
      const job = await api('ai/job');
      if (job.kind) studio.jobKind = job.kind;
      if (job.state === 'running') { studio.aiBusy = true; studio.progress = job.progress; updateAIProgress(); await wait(1500); continue; }
      studio.aiBusy = false; updateAIProgress();
      if (job.state === 'completed') {
        studio.recFailure = '';
        studio.result = job.result; if (studio.jobKind !== 'recommendations' && !job.canceled) studio.signature = studio.activeSignature; studio.selection.clear(); studio.recRows.clear(); studio.recChoices.clear();
        renderAnalysis(); renderRecommendations();
        if (!job.canceled) toast(job.result.demo ? '离线示例已载入。' : studio.jobKind === 'recommendations' ? '新推荐已生成。' : '分析完成。');
      } else if (job.state === 'error') {
        if (job.kind === 'recommendations') studio.recFailure = recommendationSignature();
        aiError(job.error + (job.kind === 'recommendations' ? ' 当前仍显示上一批。' : job.progress?.done ? ` 已完成 ${job.progress.done} 首；重新分析相同来源可复用本次已完成批次。` : ''));
      }
      else if (studio.result === null) aiError('分析任务已清除。');
      break;
    }
  } catch (error) {
    studio.suspended = true; aiError('进度读取中断：' + error.message + ' 可继续查看，不会重复提交任务。'); toggle('btn-ai-resume', true); toggle('btn-rec-resume', true);
  } finally { studio.polling = false; updateStudio(); }
}
function svgNode(tag, attributes = {}) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
  return node;
}
function drawRadar(axes) {
  const svg = $('style-radar'); svg.replaceChildren();
  const title = svgNode('title'); title.textContent = axes.map(axis => axis.label + '：' + (axis.value === null ? '资料不足' : axis.value + ' / 5')).join('；'); svg.append(title);
  const cx = 210, cy = 174, radius = 117;
  function point(index, distance) { const angle = -Math.PI / 2 + index * Math.PI / 3; return [cx + Math.cos(angle) * distance, cy + Math.sin(angle) * distance]; }
  for (let level = 1; level <= 5; level++) svg.append(svgNode('polygon', { points: axes.map((_, index) => point(index, radius * level / 5).join(',')).join(' '), class: 'radar-grid' }));
  axes.forEach((axis, index) => {
    const p = point(index, radius); svg.append(svgNode('line', { x1: cx, y1: cy, x2: p[0], y2: p[1], class: 'radar-axis' }));
    const labelPoint = point(index, radius + 26); const label = svgNode('text', { x: labelPoint[0], y: labelPoint[1] + 4, 'text-anchor': 'middle', class: 'radar-label' }); label.textContent = axis.label; svg.append(label);
  });
  [1, 3, 5].forEach(level => { const label = svgNode('text', { x: cx + 5, y: cy - radius * level / 5 + 10, class: 'radar-number' }); label.textContent = level; svg.append(label); });
  if (axes.every(axis => axis.value !== null)) svg.append(svgNode('polygon', { points: axes.map((axis, index) => point(index, radius * axis.value / 5).join(',')).join(' '), class: 'radar-shape' }));
  axes.forEach((axis, index) => { if (axis.value === null) return; const p = point(index, radius * axis.value / 5); svg.append(svgNode('circle', { cx: p[0], cy: p[1], r: 4, class: 'radar-point' })); });
}
function showEvidence(refs, heading, axis = null) {
  const result = studio.result;
  if (!result) return;
  $('evidence-title').textContent = heading || '参考歌曲';
  const fragment = document.createDocumentFragment();
  if (axis) {
    const summary = element('section', 'evidence-summary');
    summary.append(element('strong', 'evidence-overall', axis.value === null ? '资料不足' : `${axis.value} / 5`), element('p', '', axis.explanation || '上次结果没有提供完整的维度说明，请重新分析。'));
    const scale = element('div', 'evidence-scale'); scale.append(element('p', '', '低分端 · ' + (axis.low || '该特征较弱')), element('p', '', '高分端 · ' + (axis.high || '该特征突出'))); summary.append(scale);
    summary.append(element('p', 'text-hint', `下面展示 ${refs.length} 首代表曲目${axis.id === 'diversity' ? '的流派标签' : '在该维度的分数与判断理由'}${axis.range && axis.range[0] !== axis.range[1] ? '，包含接近整体值的曲目及对照' : ''}。`));
    summary.append(element('p', 'evidence-confidence', '依据歌曲资料估计，未分析音频。低分表示这一特征较少，不代表歌曲不好。')); fragment.append(summary);
  }
  for (const ref of refs) {
    const track = result.source.tracks.find(value => value.ref === ref); if (!track) continue;
    const observation = result.observations.find(value => value.ref === ref);
    const item = element('section', 'evidence-item'); item.append(element('h4', '', track.title), element('p', 'text-hint', [track.artist, track.album, track.year].filter(Boolean).join(' · ')));
    if (axis && axis.id !== 'diversity') {
      const score = observation?.scores?.[axis.id];
      item.append(element('p', 'evidence-score', `${axis.label} · ${score === null || score === undefined ? '未知' : score + ' / 5'} · ${({ high: '较高把握', medium: '中等把握', low: '低把握' })[observation?.confidence] || '把握未知'}`));
      item.append(element('p', '', observation?.axisReasons?.[axis.id] || '这份结果未提供该维度的具体理由，无法用通用歌曲介绍解释此分数；请重新分析。'));
    } else if (axis) item.append(element('p', '', '估计流派 · ' + (observation?.genres?.join(' / ') || '未知')));
    else item.append(element('p', '', observation?.reason || '该曲目作为点评参考，模型未提供详细判断依据。'));
    fragment.append(item);
  }
  if (!refs.length) fragment.append(element('p', 'text-hint', '资料不足，尚无可用参考歌曲。'));
  $('evidence-content').replaceChildren(fragment); $('modal-evidence').showModal();
}
function referencePills(refs) {
  const row = element('div', 'reference-pills');
  refs.forEach(ref => { const track = studio.result.source.tracks.find(value => value.ref === ref); if (!track) return; const button = element('button', 'reference-pill', track.title); button.title = track.title + ' — ' + track.artist; button.addEventListener('click', () => showEvidence([ref], '参考歌曲')); row.append(button); });
  return row;
}
function reviewPoints(id, values) {
  const fragment = document.createDocumentFragment();
  values.forEach(value => { const point = element('div', 'review-point'); point.append(element('p', '', value.text), referencePills(value.refs)); fragment.append(point); });
  if (!values.length) fragment.append(element('p', 'text-hint', '暂未取得有歌曲依据的点评。'));
  $(id).replaceChildren(fragment);
}
function renderAnalysis() {
  const result = studio.result;
  $('profile-title').textContent = result.source.title;
  $('profile-coverage').textContent = `${result.coverage.known} / ${result.coverage.total} 首有资料判断${result.source.sampled ? ` · 从 ${result.source.total} 首中均匀抽样` : ''}${result.demo ? ' · 离线示例数据' : ''}`;
  const uncertain = result.observations.filter(value => value.known && value.confidence === 'low').length;
  $('profile-confidence').textContent = result.demo ? '演示画像 · 数值仅用于体验交互' : `资料估计 · ${result.coverage.total - result.coverage.known} 首未知${uncertain ? ` · ${uncertain} 首把握较低` : ''} · 点维度查看理由`;
  $('profile-tags').replaceChildren(...result.tags.map(tag => element('span', '', tag)));
  $('profile-summary').textContent = result.summary || '模型未提供概述。';
  $('review-tone-label').textContent = result.tone === 'sharp' ? '直白锐评' : '认真乐评';
  $('profile-basis').textContent = result.basis + (result.demo ? ' 当前为明确标注的模拟数据，不是对输入歌曲的实际评定。' : '');
  drawRadar(result.axes);
  const buttons = result.axes.map(axis => {
    const button = element('button', 'axis-button'); button.append(element('span', '', axis.label));
    const score = element('strong', '', axis.value === null ? '—' : axis.value); score.append(element('small', '', axis.value === null ? '' : '/ 5')); button.append(score);
    button.setAttribute('aria-label', axis.label + '，查看评分依据和 ' + axis.evidence.length + ' 首代表歌曲');
    button.addEventListener('click', () => showEvidence(axis.evidence, axis.label + ' · 评分依据', axis)); return button;
  });
  $('axis-buttons').replaceChildren(...buttons);
  const fragment = document.createDocumentFragment();
  result.genres.forEach(genre => {
    const row = element('div', 'genre-row'); row.append(element('span', '', genre.name)); const bar = svgNode('svg', { viewBox: '0 0 100 4', preserveAspectRatio: 'none', 'aria-hidden': 'true' }); bar.append(svgNode('rect', { width: 100, height: 4, fill: '#eff0f4' }), svgNode('rect', { width: Math.max(0, Math.min(100, genre.share)), height: 4, fill: '#babfca' })); row.append(bar, element('span', '', genre.share + '%')); fragment.append(row);
  });
  $('genre-distribution').replaceChildren(fragment);
  reviewPoints('review-strengths', result.strengths); reviewPoints('review-blindspots', result.blindspots);
  toggle('analysis-empty', false); toggle('analysis-report', true); updateStudio();
}
function renderRecommendations() {
  const values = studio.result?.recommendations || [];
  studio.selection = new Set(values.flatMap((value, index) => studio.queue.has(trackKey(value)) ? [index] : []));
  toggle('discover-empty', !values.length); toggle('recommendation-toolbar', !!values.length);
  const fragment = document.createDocumentFragment();
  values.forEach((value, index) => {
    const card = element('article', 'recommendation-card'); const heading = element('div', 'recommendation-heading');
    const art = element('div', 'recommendation-art art-' + index % 4); art.setAttribute('aria-hidden', 'true');
    art.append(element('span', 'poster-number', String(index + 1).padStart(2, '0')), element('span', 'poster-disc'), element('span', 'poster-line'));
    const row = studio.recRows.get(index);
    const chosen = row?.candidates.find(candidate => candidate.id === studio.recChoices.get(index));
    const preview = chosen || row?.candidates[0];
    const coverNote = element('span', 'cover-note', chosen ? preview.cover ? '已选版本' : '已选版本 · 暂无封面' : row?.candidates.length ? '候选封面 · 版本待确认' : '封面待匹配');
    if (isCover(preview?.cover)) {
      const cover = element('img', 'recommendation-cover'); cover.src = preview.cover; cover.alt = '专辑封面：' + preview.album; cover.loading = 'lazy'; cover.referrerPolicy = 'no-referrer';
      cover.addEventListener('error', () => { cover.remove(); coverNote.textContent = '封面暂不可显示 · 已保留版本'; }); art.append(cover);
    }
    art.append(coverNote);
    const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.checked = studio.selection.has(index); checkbox.setAttribute('aria-label', '加入待选：' + value.title);
    checkbox.addEventListener('change', () => { setRecommendationSelected(index, checkbox.checked); checkbox.checked = studio.queue.has(trackKey(value)); updateRecommendationCount(); updateStudio(); });
    const title = element('div'); title.append(element('h2', 'recommendation-title', chosen?.title || value.title), element('p', 'recommendation-artist', chosen?.artist || value.artist));
    const select = element('label', 'rec-select'); select.title = '加入待选，换一批也保留'; select.append(checkbox);
    const mark = element('span', 'recommendation-mark'); mark.setAttribute('aria-hidden', 'true'); heading.append(select, title, mark);
    const album = element('p', 'rec-album', preview ? (chosen ? preview.album : '待确认 · ' + preview.album) : row?.error ? '封面与发行版本暂未取得' : row ? '曲库未找到，请尝试调整歌名后匹配。' : '尚未匹配曲库版本');
    const versions = element('button', 'rec-version-button btn btn-outline', row?.candidates.length ? '选择专辑 / 版本' : row?.error ? '重试此首查询' : '查找封面 / 版本'); versions.addEventListener('click', () => chooseRecommendationVersion(index));
    card.append(art, heading, album, element('p', 'recommendation-reason', value.reason));
    if (value.connection) card.append(element('p', 'recommendation-connection', '连接 · ' + value.connection));
    if (value.difference) card.append(element('p', 'recommendation-difference', '变化 · ' + value.difference));
    if (row?.error) { const error = element('p', 'rec-error', row.error); error.setAttribute('role', 'alert'); card.append(error); }
    const feedback = element('div', 'taste-actions'); feedback.setAttribute('role', 'group'); feedback.setAttribute('aria-label', '听歌反馈：' + value.title);
    const currentMark = studio.feedback.find(track => trackKey(track) === trackKey(value))?.mark;
    for (const [mark, label] of Object.entries(tasteLabels)) {
      const button = element('button', 'taste-button' + (currentMark === mark ? ' active' : ''), label);
      button.setAttribute('aria-pressed', String(currentMark === mark)); button.setAttribute('aria-label', label + '：' + value.title);
      button.addEventListener('click', () => setTasteFeedback(value, mark)); feedback.append(button);
    }
    card.append(referencePills(value.refs), versions, feedback); fragment.append(card);
  });
  $('recommendation-list').replaceChildren(fragment);
  if (studio.result) $('discover-source-label').textContent = studio.result.source.title + ' · ' + ({ familiar: '贴近口味', expand: '向外延伸', adventurous: '尝试跨界' })[studio.result.direction] + (studio.result.demo ? ' · 离线示例' : '');
  updateRecommendationCount(); updateStudio();
}
function updateRecommendationCount() { $('recommendation-count').textContent = `本批 ${studio.result?.recommendations.length || 0} 首 · ${studio.selection.size} 已选`; }
function setRecommendationSelected(index, selected) {
  const value = studio.result?.recommendations[index]; if (!value) return;
  const key = trackKey(value);
  if (!selected) { studio.queue.delete(key); studio.selection.delete(index); return; }
  if (studio.queue.size >= 200 && !studio.queue.has(key)) { toast('待选已达 200 首，请先核对或移除一些歌曲。'); return; }
  const id = studio.recChoices.get(index), candidate = studio.recRows.get(index)?.candidates.find(value => value.id === id);
  studio.queue.set(key, { title: value.title, artist: value.artist, id: id || '', platform: state.platform, album: candidate?.album || '' }); studio.selection.add(index);
}
function updateQueuedVersion(index) {
  const value = studio.result?.recommendations[index], entry = value && studio.queue.get(trackKey(value));
  const id = studio.recChoices.get(index);
  if (entry && id) { entry.id = id; entry.album = studio.recRows.get(index)?.candidates.find(value => value.id === id)?.album || ''; }
}
function renderQueue() {
  $('queue-tracks').replaceChildren(...[...studio.queue].map(([key, value]) => {
    const item = element('li', 'taste-record'); const detail = element('div');
    detail.append(element('strong', '', value.title), element('p', '', [value.artist, value.album].filter(Boolean).join(' · ')));
    const remove = element('button', 'text-btn queue-remove', '移除'); remove.setAttribute('aria-label', '移除待选：' + value.title);
    remove.addEventListener('click', () => { studio.queue.delete(key); renderRecommendations(); renderQueue(); }); item.append(detail, remove); return item;
  }));
  toggle('queue-empty', !studio.queue.size); updateStudio();
}
async function lookupRecommendation(index, snapshot) {
  const value = snapshot.recommendations[index];
  try {
    const row = await api('recommendation/search', { title: value.title, artist: value.artist });
    if (snapshot !== studio.result) return;
    const entry = studio.queue.get(trackKey(value));
    studio.recRows.set(index, row); studio.recChoices.set(index, entry?.id ? row.candidates.some(candidate => candidate.id === entry.id) ? entry.id : '' : row.selected || '');
    updateQueuedVersion(index);
  } catch (error) {
    if (snapshot !== studio.result) return;
    studio.recRows.set(index, { candidates: [], error: '版本查询未完成：' + error.message });
  }
  renderRecommendations();
}
async function loadRecommendationCovers() {
  if (locked() || !studio.result) return;
  const snapshot = studio.result;
  await run(async () => {
    for (let index = 0; index < snapshot.recommendations.length; index++) {
      if (snapshot !== studio.result) break;
      $('recommendation-count').textContent = `正在查找 ${index + 1} / ${snapshot.recommendations.length} 首的封面与版本…`;
      if (!studio.recRows.has(index) || studio.recRows.get(index).error) await lookupRecommendation(index, snapshot);
    }
  });
  updateRecommendationCount();
}
async function chooseRecommendationVersion(index) {
  if (locked() || !studio.result) return;
  if (!studio.recRows.get(index)?.candidates.length) await run(() => lookupRecommendation(index, studio.result));
  const row = studio.recRows.get(index); if (!row?.candidates.length) return;
  studio.recVersionIndex = index; studio.recVersionId = studio.recChoices.get(index) || '';
  $('rec-versions-title').textContent = '专辑与版本 · ' + studio.result.recommendations[index].title;
  const options = row.candidates.map(candidate => {
    const label = element('label', 'candidate-option rec-candidate'); const radio = element('input'); radio.type = 'radio'; radio.name = 'rec-version'; radio.value = candidate.id; radio.checked = candidate.id === studio.recVersionId;
    radio.addEventListener('change', () => { studio.recVersionId = candidate.id; updateStudio(); }); label.append(radio);
    if (isCover(candidate.cover)) { const image = element('img', 'candidate-cover'); image.src = candidate.cover; image.alt = candidate.album; image.loading = 'lazy'; image.referrerPolicy = 'no-referrer'; label.append(image); }
    const detail = element('div', 'candidate-meta'); detail.append(element('strong', 'candidate-title', candidate.title), element('p', 'candidate-desc', candidate.artist + ' · ' + candidate.album));
    detail.append(element('p', 'candidate-favorites', candidate.favorites === null || candidate.favorites === undefined ? '收藏人数未知' : (row.favoriteDemo ? '模拟 ' : '') + (candidate.favoriteDisplay ? candidate.favoriteDisplay + ' 收藏' + (candidate.favoriteApproximate ? ' · 平台量级' : '') : candidate.favorites.toLocaleString('zh-CN') + ' 人收藏')));
    if (candidate.variantMismatch) detail.append(element('p', 'candidate-warning', '录音版本与原推荐不同，请确认是否喜欢。'));
    if (candidate.writeBlocked) detail.append(element('p', 'candidate-warning', '类型信息不一致 · 封面可浏览，导入前需重新匹配核对。'));
    label.append(detail); return label;
  });
  $('rec-version-list').replaceChildren(...options); updateStudio(); $('modal-rec-versions').showModal();
}
function confirmRecommendationVersion() {
  if (locked()) return;
  const index = studio.recVersionIndex, id = studio.recVersionId;
  if (!studio.recRows.get(index)?.candidates.some(candidate => candidate.id === id)) return;
  studio.recChoices.set(index, id); updateQueuedVersion(index); $('modal-rec-versions').close(); renderRecommendations(); toast('已选择歌曲版本与对应封面。');
}
function showSourceTracks() {
  const tracks = sourceTracks(); $('source-tracks-title').textContent = $('analysis-source-name').textContent;
  $('source-tracks-description').textContent = `当前可查看 ${tracks.length} 条资料。本次分析 ${Math.min(tracks.length, analysisLimit())} 首，分批处理${tracks.length > analysisLimit() ? '，均匀抽样' : '，覆盖全部已读取曲目'}。`;
  $('source-tracks-list').replaceChildren(...tracks.map((track, index) => {
    const item = element('li', 'source-track'); item.append(element('span', 'source-track-number', String(index + 1).padStart(2, '0')));
    const detail = element('div'); detail.append(element('strong', '', track.title), element('p', '', [track.artist, track.album].filter(Boolean).join(' · '))); item.append(detail); return item;
  })); $('modal-source-tracks').showModal();
}
function matchRecommendations() {
  if (locked() || studio.aiBusy || !studio.queue.size) return;
  const rows = [...studio.queue.values()].filter(value => value.platform === state.platform);
  if (!rows.length) return;
  const text = rows.map(value => value.title + ' — ' + value.artist).join('\n');
  const preferred = rows.flatMap(value => value.id ? [{ title: value.title, artist: value.artist, id: value.id }] : []);
  $('modal-rec-queue').close();
  $('input-order').value = 'title-first'; $('input-tracks').value = text; resetPlan(); state.requestedVersions = preferred; studioPage('playlist'); $('btn-match').click();
}

document.querySelectorAll('.nav-item').forEach(button => button.addEventListener('click', () => studioPage(button.dataset.page)));
document.querySelectorAll('.brand').forEach(button => button.addEventListener('click', event => { event.preventDefault(); studioPage('playlist'); }));
document.querySelectorAll('.studio-close').forEach(button => button.addEventListener('click', () => button.closest('dialog').close()));
$('btn-go-analysis').addEventListener('click', () => studioPage('analysis'));
$('btn-profile-discover').addEventListener('click', () => studioPage('discover'));
$('btn-discover-analyze').addEventListener('click', () => studio.result ? startRecommendations() : studioPage('analysis'));
$('btn-analysis-add-songs').addEventListener('click', () => $('btn-toggle-input').click());
$('btn-toggle-input').addEventListener('click', () => { studioPage('playlist'); $('input-tracks').focus(); $('input-tracks').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); });
$('btn-ai-settings').addEventListener('click', showSettings);
$('btn-analysis-ai').addEventListener('click', showSettings);
$('ai-provider').addEventListener('change', fillProvider); $('ai-model').addEventListener('input', updateProviderPricing);
$('btn-clear-all-ai').addEventListener('click', () => configureAI(true, true));
$('btn-source-tracks').addEventListener('click', showSourceTracks); $('btn-source-picker').addEventListener('click', () => $('btn-select-playlist').click());
$('btn-load-covers').addEventListener('click', loadRecommendationCovers); $('btn-confirm-rec-version').addEventListener('click', confirmRecommendationVersion);
$('btn-save-ai-key').addEventListener('click', () => configureAI(false)); $('btn-clear-ai-key').addEventListener('click', () => configureAI(true));
['btn-read-playlist', 'btn-read-from-playlist'].forEach(id => $(id).addEventListener('click', readForAnalysis));
['btn-analyze', 'btn-analyze-empty'].forEach(id => $(id).addEventListener('click', startAnalysis));
$('btn-new-recommendations').addEventListener('click', startRecommendations);
['btn-ai-cancel','btn-rec-cancel'].forEach(id => $(id).addEventListener('click', cancelAI));
$('btn-rec-resume').addEventListener('click', () => { if (!studio.polling) void pollAnalysis(); });
$('btn-ai-resume').addEventListener('click', () => { if (!studio.polling) { aiError(); void pollAnalysis(); } });
$('analysis-source').addEventListener('change', updateStudio);
['analysis-tone', 'analysis-limit'].forEach(id => $(id).addEventListener('change', updateStudio));
function recommendationSettingsChanged() { studio.recFailure = ''; $('discover-error').textContent = ''; toggle('discover-error', false); updateStudio(); }
$('analysis-direction').addEventListener('change', recommendationSettingsChanged); $('discover-preferences').addEventListener('input', recommendationSettingsChanged);
$('btn-select-recommendations').addEventListener('click', () => { (studio.result?.recommendations || []).forEach((_, index) => setRecommendationSelected(index, true)); renderRecommendations(); });
$('btn-clear-recommendations').addEventListener('click', () => { (studio.result?.recommendations || []).forEach((_, index) => setRecommendationSelected(index, false)); renderRecommendations(); });
$('btn-match-recommendations').addEventListener('click', matchRecommendations);
$('btn-open-queue').addEventListener('click', () => { renderQueue(); $('modal-rec-queue').showModal(); });
$('btn-queue-match').addEventListener('click', matchRecommendations);
$('btn-clear-queue').addEventListener('click', () => { studio.queue.clear(); renderRecommendations(); renderQueue(); });
$('btn-taste-records').addEventListener('click', () => { renderTasteRecords(); toggle('taste-clear-confirm', false); $('modal-taste').showModal(); });
$('btn-clear-taste').addEventListener('click', () => toggle('taste-clear-confirm', true));
$('btn-cancel-clear-taste').addEventListener('click', () => toggle('taste-clear-confirm', false));
$('btn-confirm-clear-taste').addEventListener('click', () => {
  if (studio.aiBusy || locked()) return;
  studio.feedback = []; saveTasteRecords(); toggle('taste-clear-confirm', false); recommendationSettingsChanged(); renderRecommendations(); renderTasteRecords(); toast('口味记录已清除。');
});
$('btn-export-analysis').addEventListener('click', () => { if (studio.result) download('歌单接力-分析.json', JSON.stringify(studio.result, null, 2), 'application/json;charset=utf-8'); });
updateStudio();
(async () => {
  try {
    await platformReady;
    const result = await api('ai/status'); applyAIStatus(result); updateStudio();
    const source = await api('analysis/source'); if (source.source) { studio.playlist = source.source; $('analysis-source').value = 'playlist'; updateStudio(); }
    const job = await api('ai/job');
    if (job.state === 'running') { studio.aiBusy = true; studioPage('analysis'); await pollAnalysis(); }
    else if (job.result) {
      studio.result = job.result; $('analysis-direction').value = job.settings?.direction || job.result.direction;
      $('discover-preferences').value = job.settings?.preferences ?? job.result.recommendationPreferences ?? job.result.preferences ?? '';
      if (job.state === 'error' && job.kind === 'recommendations') { studio.jobKind = job.kind; studio.recFailure = recommendationSignature(); aiError(job.error + ' 当前仍显示上一批。'); }
      renderAnalysis(); renderRecommendations();
    }
  } catch (error) { aiError(error.message); }
  finally { studio.ready = true; updateStudio(); }
})();
