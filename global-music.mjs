import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const spotifyId = id => /^[A-Za-z0-9]{22}$/.test(String(id));
const appleId = id => /^p\.[A-Za-z0-9.-]{2,100}$/.test(String(id));
const checked = (id, valid) => { if (!valid(id)) throw new Error('歌曲或歌单 ID 格式不正确。'); return String(id); };
const sample = (rows, n = 200) => rows.length <= n ? rows : Array.from({ length:n }, (_, i) => rows[Math.floor(i * (rows.length - 1) / (n - 1))]);
const epochCheck = (value, epoch) => { if (value.epoch !== epoch) throw new Error('登录已取消或更换，请重新授权。'); };

async function request(fetcher, base, path, { method = 'GET', headers = {}, body, form, label } = {}) {
  const url = new URL(path, base);
  if (url.origin !== new URL(base).origin || url.username || url.password || url.hash) throw new Error('分页地址不在官方接口范围内，已停止。');
  let response;
  try { response = await fetcher(url.href, { method, redirect:'error', signal:AbortSignal.timeout(20000), headers:{ ...headers, ...(body ? { 'Content-Type':'application/json' } : form ? { 'Content-Type':'application/x-www-form-urlencoded' } : {}) }, body:body ? JSON.stringify(body) : form ? new URLSearchParams(form).toString() : undefined }); }
  catch { throw new Error(`${label}请求中断或超时。写入可能已生效，请先核对歌单，不会自动重试。`); }
  if (!response.ok) {
    if (response.status === 429) throw new Error(`${label}额度或速率限制（429），已停止，不会自动重试。`);
    if (response.status === 401 || response.status === 403) throw new Error(`${label}授权或权限不足（${response.status}），请检查账号、授权范围和开发者配置。`);
    throw new Error(`${label}拒绝请求（${response.status}），已停止，不会自动重试。`);
  }
  if (response.status === 204) return {};
  const content = await response.text();
  if (!content) return {};
  if (content.length > 4000000) throw new Error(`${label}响应过大，已停止。`);
  try { return JSON.parse(content); } catch { throw new Error(`${label}未返回有效 JSON，已停止。`); }
}

const SPOTIFY_SCOPES = ['playlist-read-private','playlist-modify-private','playlist-modify-public'];
export class Spotify {
  constructor({ fetch:fetcher = globalThis.fetch, clientId = '' } = {}) {
    this.platform = 'spotify'; this.fetcher = fetcher; this.epoch = 0; this.clientId = ''; this.clear();
    if (clientId) this.configure({ clientId });
  }
  capabilities() { return { oauth:true, qr:false, cookie:false, create:true, privateCreate:true, favorites:false, experimental:true, aiAnalysis:false, aiReason:'Spotify 政策不允许分析平台内容或将其输入 AI。此平台用于歌曲匹配与歌单导入。' }; }
  sessionInfo() { return { hasSession:!!this.tokens, verified:!!this.profile, configured:!!this.clientId, configurationError:this.configurationError||'', source:'oauth', authPending:!!this.pending }; }
  configure({ clientId }) {
    if (!/^[a-fA-F0-9]{32}$/.test(String(clientId || ''))) throw new Error('请填写 Spotify 开发应用的 32 位 Client ID，不要填写 Client Secret。');
    this.clear(); this.configurationError=''; this.clientId = String(clientId); return this.sessionInfo();
  }
  beginAuth(redirectUri) {
    if (!this.clientId) throw new Error('请先配置自己的 Spotify Client ID。');
    const uri = new URL(redirectUri);
    if (uri.protocol !== 'http:' || uri.hostname !== '127.0.0.1' || !uri.port || uri.pathname !== '/oauth/spotify/callback' || uri.search || uri.hash) throw new Error('仅支持本机回调地址。');
    this.cancelAuth();
    const state = randomBytes(32).toString('hex'), verifier = randomBytes(48).toString('base64url');
    this.pending = { state, verifier, redirectUri:uri.href, expires:Date.now()+600000, epoch:this.epoch };
    const params = new URLSearchParams({ client_id:this.clientId, response_type:'code', redirect_uri:uri.href, scope:SPOTIFY_SCOPES.join(' '), state, code_challenge_method:'S256', code_challenge:createHash('sha256').update(verifier).digest('base64url') });
    return { authorizeUrl:'https://accounts.spotify.com/authorize?'+params, redirectUri:uri.href };
  }
  async finishAuth({ state, code, error }) {
    const pending = this.pending;
    if (!pending || pending.expires < Date.now() || !/^[a-f0-9]{64}$/.test(String(state || '')) || !timingSafeEqual(Buffer.from(state),Buffer.from(pending.state))) throw new Error('Spotify 回调校验失败或授权已过期。');
    this.pending = null;
    if (error || typeof code !== 'string' || !code || code.length > 4096) throw new Error('Spotify 授权未完成，请重新发起授权。');
    const token = await request(this.fetcher, 'https://accounts.spotify.com', '/api/token', { method:'POST', form:{ grant_type:'authorization_code', code, redirect_uri:pending.redirectUri, client_id:this.clientId, code_verifier:pending.verifier }, label:'Spotify' });
    epochCheck(this,pending.epoch);
    if (typeof token.scope !== 'string' || SPOTIFY_SCOPES.some(scope => !token.scope.split(' ').includes(scope))) throw new Error('Spotify 未授予完整歌单权限，请重新确认授权。');
    const tokens = this.tokenData(token);
    const profile = await request(this.fetcher,'https://api.spotify.com','/v1/me',{headers:{Authorization:'Bearer '+tokens.access},label:'Spotify'});
    epochCheck(this,pending.epoch);
    if (!profile.id) throw new Error('Spotify 未返回账号标识，未建立会话。');
    this.tokens = tokens; this.profile = { id:String(profile.id), name:String(profile.display_name || profile.id) };
    return this.profile;
  }
  tokenData(data, previous) {
    if (typeof data.access_token !== 'string' || !data.access_token || data.access_token.length > 8000 || !(Number(data.expires_in) > 0)) throw new Error('Spotify 未返回有效的授权令牌。');
    return { access:data.access_token, refresh:data.refresh_token || previous?.refresh || '', expires:Date.now()+Number(data.expires_in)*1000 };
  }
  async access() {
    if (!this.tokens) throw new Error('请先通过 Spotify 官方页面授权。');
    if (this.tokens.expires > Date.now()+30000) return this.tokens.access;
    if (!this.tokens.refresh) throw new Error('Spotify 授权已过期，请重新登录。');
    if (!this.refreshing) {
      const epoch = this.epoch, previous = this.tokens;
      const promise = request(this.fetcher,'https://accounts.spotify.com','/api/token',{method:'POST',form:{grant_type:'refresh_token',refresh_token:previous.refresh,client_id:this.clientId},label:'Spotify'}).then(data=>{epochCheck(this,epoch);this.tokens=this.tokenData(data,previous);return this.tokens.access;});
      this.refreshing = promise;
      promise.finally(()=>{if(this.refreshing===promise)this.refreshing=null;}).catch(()=>{});
    }
    return this.refreshing;
  }
  async call(path, options = {}) { const epoch=this.epoch, access=await this.access(); epochCheck(this,epoch); const value=await request(this.fetcher,'https://api.spotify.com',path,{...options,headers:{Authorization:'Bearer '+access},label:'Spotify'}); epochCheck(this,epoch);return value; }
  async user() { await this.access(); if (!this.profile) throw new Error('Spotify 账号尚未验证。'); return this.profile; }
  async verifySession() {const epoch=this.epoch,p=await this.call('/v1/me');epochCheck(this,epoch);if(!p.id)throw new Error('Spotify 未返回账号标识。');this.profile={id:String(p.id),name:String(p.display_name||p.id)};return this.profile;}
  async pages(path) {
    const rows=[],seen=new Set();
    while (path) { if(seen.has(path)||seen.size>=100)throw new Error('Spotify 分页异常或歌单过大，停止完整读回。');seen.add(path);const page=await this.call(path);if(!Array.isArray(page.items))throw new Error('Spotify 未返回完整条目，停止读回。');rows.push(...page.items);path=page.next||''; }
    return rows;
  }
  async playlists() { const user=await this.user();return (await this.pages('/v1/me/playlists?limit=50')).filter(p=>p?.owner?.id===user.id).map(p=>({id:p.id,name:p.name,count:p.items?.total??p.tracks?.total??null})); }
  song(item) { return { id:item.id, platform:'spotify', name:item.name, ar:item.artists || [], al:{name:item.album?.name||'',picUrl:item.album?.images?.[0]?.url||''}, dt:item.duration_ms||0, publishTime:Date.parse(item.album?.release_date||'')||0, externalUrl:item.external_urls?.spotify||`https://open.spotify.com/track/${item.id}` }; }
  async search(row) { await this.pause();const q=`track:${row.title}${row.artist?' artist:'+row.artist:''}`;const data=await this.call('/v1/search?'+new URLSearchParams({q,type:'track',limit:'10'}));return (data.tracks?.items||[]).filter(t=>spotifyId(t.id)).map(t=>this.song(t)); }
  async content(id) { id=checked(id,spotifyId);const playlist=await this.call('/v1/playlists/'+id);const items=await this.pages(`/v1/playlists/${id}/items?limit=50`);return {playlist,items}; }
  async detail(id) {
    const {playlist,items}=await this.content(id),ids=[];
    for(const row of items){const item=row.item||row.track;if(!item){throw new Error('Spotify 歌单含无法识别的条目，无法完整核对，已停止导入。');}if(item.type==='episode')continue;if(item.is_local)continue;if(!spotifyId(item.id))throw new Error('Spotify 歌曲 ID 缺失，无法完整核对。');ids.push(item.id);if(spotifyId(item.linked_from?.id))ids.push(item.linked_from.id);}
    return {id:String(id),name:playlist.name,creator:{userId:playlist.owner?.id},trackIds:[...new Set(ids)].map(id=>({id}))};
  }
  async readPlaylist(id) { const {playlist,items}=await this.content(id);const songs=items.map(x=>x.item||x.track).filter(x=>x?.type==='track'&&!x.is_local&&x.name);return {id:String(id),title:playlist.name,total:items.length,sampled:songs.length>200,aiAllowed:false,tracks:sample(songs).map(s=>({title:s.name,artist:(s.artists||[]).map(x=>x.name).join(' / '),album:s.album?.name||'',sourcePlatform:'spotify'}))}; }
  async create(name,privacy='10') { await this.user();if(!String(name).trim()||String(name).length>100)throw new Error('请填写有效歌单名称。');if(!['10','0'].includes(privacy))throw new Error('歌单可见性不正确。');const result=await this.call('/v1/me/playlists',{method:'POST',body:{name:String(name).trim(),public:privacy==='0'}});return {id:checked(result.id,spotifyId),name:result.name||name}; }
  async add(pid,ids) { checked(pid,spotifyId);if(!Array.isArray(ids)||!ids.length||ids.length>10)throw new Error('本批限 1–10 首。');await this.call(`/v1/playlists/${pid}/items`,{method:'POST',body:{uris:ids.map(id=>'spotify:track:'+checked(id,spotifyId))}}); }
  playlistUrl(id) { return 'https://open.spotify.com/playlist/'+checked(id,spotifyId); }
  async pause() { await wait(400); }
  cancelAuth() { this.pending=null;this.epoch++; }
  clear() { this.cancelAuth();this.tokens=null;this.profile=null;this.refreshing=null; }
}

export class AppleMusic {
  constructor({ fetch:fetcher=globalThis.fetch, developerToken='', storefront='us', origin='' }={}) { this.platform='apple';this.fetcher=fetcher;this.epoch=0;this.developerToken='';this.storefront=storefront;this.origin=origin;this.clear();if(developerToken)this.configure({developerToken,storefront,origin}); }
  capabilities() { return { oauth:true, qr:false, cookie:false, create:false, privateCreate:false, favorites:false, experimental:true, aiAnalysis:true, createReason:'Apple Music 首版仅追加到资料库中可编辑的已有歌单。请先在官方客户端创建歌单。' }; }
  sessionInfo() { return {hasSession:!!this.userToken,verified:!!this.verified,configured:!!this.developerToken&&this.developerExpires>Date.now(),configurationError:this.configurationError||'',developerExpires:this.developerExpires||null,source:'musickit',authPending:!!this.pending,storefront:this.storefront}; }
  configure({developerToken,storefront='us',origin=this.origin}) {
    if(typeof developerToken!=='string'||developerToken.length>12000||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(developerToken))throw new Error('需要已签名的 MusicKit Developer Token（JWT），不要粘贴 .p8 私钥。');
    let header,payload;try{header=JSON.parse(Buffer.from(developerToken.split('.')[0],'base64url'));payload=JSON.parse(Buffer.from(developerToken.split('.')[1],'base64url'));}catch{throw new Error('Developer Token 格式不正确。');}
    const now=Date.now()/1000;
    if(header.alg!=='ES256'||!/^[A-Za-z0-9]{10}$/.test(header.kid||'')||!/^[A-Za-z0-9]{10}$/.test(payload.iss||'')||!Number.isInteger(payload.iat)||payload.iat>now+300||!Number.isInteger(payload.exp)||payload.exp<=now||payload.exp<=payload.iat||payload.exp>now+15777000+300)throw new Error('Developer Token 的算法、签名信息或有效期不正确。签名将由 Apple 接口验证。');
    if(origin){let u;try{u=new URL(origin);}catch{}if(!u||u.origin!==origin||u.protocol!=='http:'||u.hostname!=='127.0.0.1'||!u.port)throw new Error('Apple 授权来源必须是当前本机地址。');}
    if(payload.origin&&(!Array.isArray(payload.origin)||!payload.origin.includes(origin)))throw new Error('Developer Token 的 origin 未包含当前本机地址。请重新签名，端口也必须一致。');
    if(!/^[a-z]{2}$/.test(storefront))throw new Error('Storefront 应为两个小写字母，例如 us 或 cn。');
    this.clear();this.configurationError='';this.developerToken=developerToken;this.developerExpires=payload.exp*1000;this.storefront=storefront;this.origin=origin;return this.sessionInfo();
  }
  beginAuth() {if(!this.developerToken)throw new Error('请先配置 MusicKit Developer Token。');this.cancelAuth();this.pending={nonce:randomBytes(32).toString('hex'),expires:Date.now()+600000,epoch:this.epoch};return {nonce:this.pending.nonce};}
  authConfig(nonce) {if(!this.sessionInfo().configured)throw new Error('MusicKit Developer Token 已过期或尚未配置。请重新签名或配置。');if(!this.pending||nonce!==this.pending.nonce||this.pending.expires<Date.now())throw new Error('Apple Music 授权入口已过期，请重新打开。');return {developerToken:this.developerToken};}
  async finishAuth(nonce,token) {
    this.authConfig(nonce);const pending=this.pending;this.pending=null;
    if(typeof token!=='string'||!token||token.length>16000||/[\r\n]/.test(token))throw new Error('MusicKit 未返回有效用户令牌。');
    const data=await request(this.fetcher,'https://api.music.apple.com','/v1/me/storefront',{headers:{Authorization:'Bearer '+this.developerToken,'Music-User-Token':token,...(this.origin?{Origin:this.origin}:{})},label:'Apple Music'});
    epochCheck(this,pending.epoch);const storefront=data.data?.[0]?.id;if(!/^[a-z]{2}$/.test(storefront||''))throw new Error('Apple Music 未返回用户地区，未建立会话。');
    this.userToken=token;this.storefront=storefront;this.verified=true;return this.user();
  }
  async call(path,options={}) {if(!this.sessionInfo().configured)throw new Error('MusicKit Developer Token 已过期或尚未配置。请重新签名或配置。');if(path.startsWith('/v1/me/')&&!this.userToken)throw new Error('请先通过 MusicKit 官方页面授权。');const epoch=this.epoch;const value=await request(this.fetcher,'https://api.music.apple.com',path,{...options,headers:{Authorization:'Bearer '+this.developerToken,...(this.userToken?{'Music-User-Token':this.userToken}:{}),...(this.origin?{Origin:this.origin}:{})},label:'Apple Music'});epochCheck(this,epoch);return value;}
  async user() {if(!this.verified||!this.userToken)throw new Error('请先授权 Apple Music 资料库。');return {id:'apple-library',name:'Apple Music 已授权资料库'};}
  async verifySession() {await this.user();const data=await this.call('/v1/me/storefront');if(!/^[a-z]{2}$/.test(data.data?.[0]?.id||''))throw new Error('Apple Music 资料库尚未验证。');this.storefront=data.data[0].id;return this.user();}
  async pages(path) {const rows=[],seen=new Set();while(path){if(seen.has(path)||seen.size>=100)throw new Error('Apple Music 分页异常或歌单过大，停止完整读回。');seen.add(path);const page=await this.call(path);if(!Array.isArray(page.data))throw new Error('Apple Music 未返回完整条目，停止读回。');rows.push(...page.data);path=page.next||'';}return rows;}
  async playlists() {await this.user();return (await this.pages('/v1/me/library/playlists?limit=100')).filter(p=>p.attributes?.canEdit===true&&appleId(p.id)).map(p=>({id:p.id,name:p.attributes.name,count:p.relationships?.tracks?.meta?.total??null}));}
  song(item) {const a=item.attributes||{};return {id:item.id,platform:'apple',name:a.name,ar:[{name:a.artistName||''}],al:{name:a.albumName||'',picUrl:(a.artwork?.url||'').replace('{w}','300').replace('{h}','300')},dt:a.durationInMillis||0,publishTime:Date.parse(a.releaseDate||'')||0,externalUrl:a.url||''};}
  async search(row) {await this.pause();const data=await this.call(`/v1/catalog/${this.storefront}/search?`+new URLSearchParams({term:row.title+' '+(row.artist||''),types:'songs',limit:'10'}));return (data.results?.songs?.data||[]).filter(x=>/^\d+$/.test(x.id)).map(x=>this.song(x));}
  async content(id) {await this.user();id=checked(id,appleId);const data=await this.call('/v1/me/library/playlists/'+id);const playlist=data.data?.[0];if(!playlist||playlist.id!==id)throw new Error('Apple Music 未返回指定资料库歌单。');const tracks=await this.pages(`/v1/me/library/playlists/${id}/tracks?limit=100`);return {playlist,tracks};}
  async detail(id) {
    const {playlist,tracks}=await this.content(id),ids=[];
    for(const t of tracks){
      if(!t.id)throw new Error('资料库歌曲 ID 缺失，无法完整核对。');
      if(t.type==='library-music-videos'||t.type==='music-videos')continue;ids.push(String(t.id));
      let catalog=t.attributes?.playParams?.catalogId||(t.type==='songs'?t.id:'')||t.relationships?.catalog?.data?.find(x=>x.type==='songs')?.id||this.catalogMap.get(t.id);
      if(!catalog&&t.type==='library-songs'){
        if(!/^i\.[A-Za-z0-9.-]{2,100}$/.test(t.id))throw new Error('资料库歌曲标识不正确。');
        await this.pause();const resource=await this.call('/v1/me/library/songs/'+t.id+'?include=catalog');
        catalog=resource.data?.[0]?.attributes?.playParams?.catalogId||resource.data?.[0]?.relationships?.catalog?.data?.find(x=>x.type==='songs')?.id;
        if(catalog)this.catalogMap.set(t.id,catalog);
      }
      if(catalog&&/^\d+$/.test(catalog))ids.push(String(catalog));else throw new Error('该歌单含无法映射到曲库的本地歌曲，暂不能完整去重，请使用专用导入歌单。');
    }
    return {id,name:playlist.attributes?.name||'Apple Music 歌单',canEdit:playlist.attributes?.canEdit===true,trackIds:[...new Set(ids)].map(id=>({id}))};
  }
  assertWritable(detail) {if(detail.canEdit!==true)throw new Error('Apple Music 未确认当前资料库歌单可编辑，已停止。');}
  async readPlaylist(id) {const {playlist,tracks}=await this.content(id);const known=tracks.filter(t=>t.attributes?.name);return {id,title:playlist.attributes?.name||'Apple Music 歌单',total:tracks.length,sampled:known.length>200,tracks:sample(known).map(t=>({title:t.attributes.name,artist:t.attributes.artistName||'',album:t.attributes.albumName||'',sourcePlatform:'apple'}))};}
  async create() {throw new Error(this.capabilities().createReason);}
  async readBack(pid,ids) {
    let latest;
    for(let attempt=0;attempt<4;attempt++) {
      if(attempt)await this.pause(1200 * 2 ** attempt);
      latest=await this.detail(pid);this.assertWritable(latest);
      const present=new Set(latest.trackIds.map(t=>String(t.id)));
      if(ids.every(id=>present.has(String(id))))return latest;
    }
    return latest;
  }
  async add(pid,ids) {checked(pid,appleId);if(!Array.isArray(ids)||!ids.length||ids.length>10||ids.some(id=>!/^\d+$/.test(id)))throw new Error('Apple Music 本批限 1–10 个曲库歌曲 ID。');await this.call(`/v1/me/library/playlists/${pid}/tracks`,{method:'POST',body:{data:ids.map(id=>({id:String(id),type:'songs'}))}});}
  playlistUrl() {return 'https://music.apple.com/library/playlists';}
  async pause(ms=1200) {await wait(ms);}
  cancelAuth() {this.pending=null;this.epoch++;}
  clear() {this.cancelAuth();this.userToken='';this.verified=false;this.developerToken='';this.developerExpires=0;this.catalogMap=new Map();}
}
