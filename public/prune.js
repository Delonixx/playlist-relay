'use strict';
const prune = { busy:false, polling:false, suspended:false, platform:'', target:'', preview:null, selection:new Set(), confirm:null, report:null, phase:'idle', error:'' };
const pruneSupported = () => state.capabilities.prune === true && ['netease','qq'].includes(state.platform);
function pruneError(message='') { prune.error=message;$('prune-error').textContent=message;toggle('prune-error',!!message); }
function discardPrune() { prune.preview=null;prune.selection.clear();prune.confirm=null;prune.report=null;prune.phase='idle';$('modal-prune-confirm').close();renderPrune(); }
function updatePrune() {
  if(prune.preview&&!prune.busy&&(prune.platform!==state.platform||prune.target!==targetId($('input-target').value))){discardPrune();pruneError('目标歌单已变化，请重新筛选。');}
  const disabled=locked()||studio.aiBusy, eligible=prune.preview?.candidates.filter(value=>value.eligible)||[];
  const id=targetId($('input-target').value), title=$('selected-playlist-name').textContent;
  $('prune-target-label').textContent=id ? `${title&&title!=='登录并选择歌单'?title:'目标歌单'} · ID ${id}` : '先选择一份你自己的歌单';
  $('prune-mode').disabled=disabled;$('prune-rule').disabled=disabled;$('prune-value').disabled=disabled;$('prune-request').disabled=disabled;
  const aiMode=$('prune-mode').value==='ai';toggle('prune-rule-fields',!aiMode);toggle('prune-ai-fields',aiMode);toggle('prune-value-zone',['artist','title','album'].includes($('prune-rule').value));
  $('prune-capability-note').textContent=state.connected&&state.capabilities.prune===undefined ? '本地服务仍是旧版，需要重启服务后才能使用整理。' : !pruneSupported() ? '此版本的删歌功能支持网易云和 QQ 音乐。当前平台尚未开放删除。' : state.demo ? '离线演示只改变模拟歌单。AI 风格筛选使用示例判断。' : aiMode ? '分批检查完整歌单，最多 1000 首；AI 只给建议，未知作品保留。' : '按实际歌曲字段筛选完整歌单，最多 1000 首。相同标题的不同 ID 需要核对版本。';
  $('btn-prune-playlist').disabled=disabled;$('btn-prune-prepare').disabled=disabled||!state.user||!id||!pruneSupported();
  $('btn-prune-prepare').textContent=prune.busy?prune.phase==='canceling'?'正在结束读取…':prune.phase==='removing'||prune.phase==='checking'?'删除并核验中…':'读取与筛选中…':'读取歌单并筛选';
  toggle('btn-prune-cancel',prune.busy&&prune.phase==='preparing');$('btn-prune-cancel').disabled=prune.suspended;
  toggle('btn-prune-resume',prune.suspended);$('btn-prune-resume').disabled=prune.polling;
  $('btn-prune-review').disabled=disabled||!prune.selection.size||!prune.preview;
  $('btn-prune-execute').disabled=disabled||!prune.confirm;
  $('btn-prune-select-all').disabled=disabled||!eligible.length;$('btn-prune-select-none').disabled=disabled||!prune.selection.size;
  $('btn-prune-backup').disabled=disabled||!prune.preview;
  $('btn-prune-ai-settings').disabled=disabled;
  $('prune-selected-label').textContent=`确认移出 ${prune.selection.size} 首 · 其余 ${Math.max(0,(prune.preview?.total||0)-prune.selection.size)} 首保留`;
  document.querySelectorAll('.prune-check').forEach(node=>node.disabled=disabled||node.dataset.eligible!=='true');
}
function renderPrune() {
  const p=prune.preview;
  $('prune-preview-title').textContent=p?`${p.title} · 待删歌曲`:prune.report?`${prune.report.playlistName} · 删除结果`:'待删歌曲';
  $('prune-count').textContent=p?`${p.candidates.length} 首建议 / ${p.total} 首已检查`:prune.report?`${prune.report.verified.length} / ${prune.report.requested.length} 首确认移出`:prune.busy?'处理中':'尚未筛选';
  $('prune-preview-description').textContent=p ? p.mode==='ai'?'逐首核对理由。取消勾选即可保留；中置信度的建议需手动选择，资料不足的作品不能删除。':'这些歌曲符合所选字段条件。取消勾选即可保留，其他歌曲不会改变。' : '只有你在预览中确认的歌曲才会移出这份歌单。';
  toggle('prune-empty',!p&&!prune.report);toggle('prune-selection-tools',!!p?.candidates.length);toggle('prune-actions',!!p?.candidates.length&&!prune.report);
  $('prune-candidates').replaceChildren(...(p?.candidates||prune.report?.requested||[]).map(value=>{
    const item=element('li','prune-candidate'), checkbox=element(prune.report?'span':'input',prune.report?'prune-status':'prune-check');
    if(prune.report){const r=prune.report;checkbox.textContent=r.verified.includes(value.id)?'✓':r.remaining.includes(value.id)?'−':'·';checkbox.setAttribute('aria-label',r.verified.includes(value.id)?'已移出':r.remaining.includes(value.id)?'仍在歌单':r.notAttempted.includes(value.id)?'未尝试':'待核对');}
    else {checkbox.type='checkbox';checkbox.checked=prune.selection.has(value.id);checkbox.dataset.eligible=String(value.eligible);checkbox.setAttribute('aria-label','从歌单移出：'+value.title+' — '+value.artist);checkbox.disabled=!value.eligible||prune.busy;checkbox.addEventListener('change',()=>{if(prune.busy||!value.eligible)return;checkbox.checked?prune.selection.add(value.id):prune.selection.delete(value.id);prune.confirm=null;updatePrune();});}
    const cover=element('div','prune-art', '♪');if(value.cover&&isCover(value.cover)){const img=element('img');img.src=value.cover;img.alt='';img.loading='lazy';cover.replaceChildren(img);}
    const content=element('div','prune-song');content.append(element('strong','',value.title),element('p','prune-meta',[value.artist,value.album].filter(Boolean).join(' · ')),element('p','prune-reason',value.reason));
    content.append(element('span','prune-basis',value.basis+(p?.mode==='ai'?' · '+({high:'高',medium:'中',low:'低'}[value.confidence]||'低')+'置信度':'')));
    if(prune.report){const r=prune.report;content.append(element('strong','prune-outcome',r.verified.includes(value.id)?'已读回确认移出':r.remaining.includes(value.id)?'仍在歌单':r.notAttempted.includes(value.id)?'尚未尝试删除':'结果待核对'));}
    item.append(checkbox,cover,content);return item;
  }));
  if(p&&!p.candidates.length){toggle('prune-empty',true);$('prune-empty').replaceChildren(element('span','empty-note','✓'),element('h3','','没有建议移除的歌曲'),element('p','','本次条件没有匹配到可删歌曲。可以修改条件再筛选。'));}
  if(!p&&!prune.report)$('prune-empty').replaceChildren(element('span','empty-note','−'),element('h3','','先说说你的新口味'),element('p','','选择歌单和条件，看看哪些歌曲符合。'));
  toggle('prune-result',!!prune.report);
  if(prune.report){const r=prune.report;$('prune-result-title').textContent=r.stopped?'整理已停止':'整理完成';$('prune-result-description').textContent=`${r.verified.length} 首已读回确认移出 · ${r.remaining.length} 首仍在歌单 · ${r.uncertain.length} 首结果待核对 · ${r.notAttempted.length} 首尚未尝试`; $('prune-result-warning').textContent=r.stopped;toggle('prune-result-warning',!!r.stopped);}
  updatePrune();
}
function adoptPrunePreview(p){prune.preview=p;prune.platform=p.platform;prune.target=p.id;prune.selection=new Set(p.candidates.filter(value=>value.eligible&&value.selected).map(value=>value.id));prune.report=null;prune.confirm=null;renderPrune();}
async function pollPrune() {
  if(prune.polling)return;prune.polling=true;prune.suspended=false;
  try{
    while(true){
      const job=await api('prune/job');prune.phase=job.state;
      if(['preparing','checking','removing','canceling'].includes(job.state)){prune.busy=true;const prog=job.progress;$('prune-count').textContent=job.state==='canceling'?'正在结束读取…':job.state==='preparing'?prog?.total?`检查 ${prog.done} / ${prog.total} 首`:'正在读取完整歌单…':`核验 ${prog?.done||0} / ${prog?.total||0} 首`;sync();await wait(1000);continue;}
      prune.busy=false;
      if(job.state==='preview')adoptPrunePreview(job.preview);
      else if(job.state==='completed'){prune.preview=null;prune.selection.clear();prune.report=job.report;prune.confirm=null;renderPrune();if(studio.playlist&&String(studio.playlist.id)===job.report.playlistId)studio.playlist.needsRefresh=true;}
      else if(job.state==='error'){prune.preview=null;prune.confirm=null;pruneError(job.error);renderPrune();}
      else {prune.preview=null;prune.confirm=null;renderPrune();}
      break;
    }
  }catch(error){prune.suspended=true;pruneError(error.message+' 本地任务可能仍在执行，请恢复进度后核对，勿重复删除。');}
  finally{prune.polling=false;sync();}
}
async function preparePrune(){
  if(locked()||studio.aiBusy||!pruneSupported())return;
  const target=targetId($('input-target').value);if(!target){pruneError('请先选择自己的目标歌单。');return;}
  discardPrune();pruneError();prune.busy=true;prune.phase='preparing';sync();
  try{await api('prune/prepare',{target,mode:$('prune-mode').value,rule:$('prune-rule').value,value:$('prune-value').value,request:$('prune-request').value});await pollPrune();}
  catch(error){prune.busy=false;pruneError(error.message);sync();}
}
function reviewPrune(){
  if(locked()||!prune.preview||!prune.selection.size)return;
  const p=prune.preview,chosen=p.candidates.filter(value=>prune.selection.has(value.id)&&value.eligible);
  if(chosen.length!==prune.selection.size){pruneError('候选已变化，请重新核对。');return;}
  prune.confirm={revision:p.revision,ids:chosen.map(value=>value.id)};
  $('prune-confirm-description').textContent=`从「${p.title}」移出 ${chosen.length} 首，保留 ${p.total-chosen.length} 首。`;
  $('prune-confirm-platform').textContent=platformName()+' · 歌单 ID '+p.id;
  $('prune-confirm-tracks').replaceChildren(...chosen.map(value=>element('li','',value.title+' — '+value.artist)));
  toggle('prune-confirm-demo',state.demo);$('modal-prune-confirm').showModal();updatePrune();
}
async function executePrune(){
  if(locked()||!prune.confirm)return;
  const confirmed=prune.confirm;prune.confirm=null;prune.busy=true;prune.phase='checking';$('modal-prune-confirm').close();pruneError();sync();
  try{await api('prune/execute',{revision:confirmed.revision,selections:confirmed.ids,confirm:true});await pollPrune();}
  catch(error){prune.busy=false;pruneError(error.message);sync();}
}
$('btn-prune-prepare').addEventListener('click',preparePrune);$('btn-prune-review').addEventListener('click',reviewPrune);$('btn-prune-execute').addEventListener('click',executePrune);
$('btn-prune-playlist').addEventListener('click',()=>{if(!locked())$('btn-select-playlist').click();});$('btn-prune-ai-settings').addEventListener('click',showSettings);
for(const id of ['prune-mode','prune-rule','prune-value','prune-request'])$(id).addEventListener(id==='prune-value'||id==='prune-request'?'input':'change',()=>{if(prune.busy)return;discardPrune();pruneError();updatePrune();});
$('btn-prune-select-all').addEventListener('click',()=>{if(locked()||!prune.preview)return;prune.selection=new Set(prune.preview.candidates.filter(value=>value.eligible).map(value=>value.id));prune.confirm=null;renderPrune();});
$('btn-prune-select-none').addEventListener('click',()=>{if(locked())return;prune.selection.clear();prune.confirm=null;renderPrune();});
$('btn-prune-cancel').addEventListener('click',async()=>{try{await api('prune/cancel');pruneError('已取消筛选。读取中的平台请求结束后即可继续。');}catch(error){pruneError(error.message);}updatePrune();});
$('btn-prune-resume').addEventListener('click',pollPrune);
$('btn-prune-backup').addEventListener('click',async()=>{if(locked()||!prune.preview)return;try{const backup=await api('prune/backup',{revision:prune.preview.revision});download('歌单接力-原歌单清单.json',JSON.stringify(backup,null,2),'application/json;charset=utf-8');}catch(error){pruneError(error.message);}});
$('btn-prune-report').addEventListener('click',()=>{if(prune.report)download('歌单接力-删除核对记录.json',JSON.stringify(prune.report,null,2),'application/json;charset=utf-8');});
// Resume a background operation after refresh without dispatching another write.
(async()=>{while(state.pending&&!state.connected)await wait(100);if(!state.connected)return;try{const job=await api('prune/job');if(['preparing','checking','removing','canceling'].includes(job.state)){prune.busy=true;studioPage('prune');await pollPrune();}else if(job.state==='completed'){prune.report=job.report;renderPrune();}}catch{}updatePrune();})();
