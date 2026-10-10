import { randomBytes } from 'node:crypto';

// Independent Web login flow. Only these official endpoints may receive requests.
const endpoints = {
  qqImage: 'https://ssl.ptlogin2.qq.com/ptqrshow',
  qqStatus: 'https://ssl.ptlogin2.qq.com/ptqrlogin',
  qqTicket: 'https://ssl.ptlogin2.graph.qq.com/check_sig',
  qqAuthorize: 'https://graph.qq.com/oauth2.0/authorize',
  wxPage: 'https://open.weixin.qq.com/connect/qrconnect',
  wxStatus: 'https://lp.open.weixin.qq.com/connect/l/qrconnect'
};
const redirect = mode => `https://y.qq.com/portal/wx_redirect.html?login_type=${mode === 'wx' ? 2 : 1}&surl=https://y.qq.com/`;
const hash = (value, start = 0) => { let h = start; for (const c of value) h = (h * 33 + c.charCodeAt(0)) | 0; return h & 0x7fffffff; };
const token = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{8,1000}$/.test(value);
export function parseQQOAuthRedirect(location, expectedState) {
  const fail = (code, reason) => { throw new Error(`QQ 授权回调校验失败（${code}：${reason}），已停止。`); };
  let url;
  try { if (typeof location !== 'string' || location.length > 12000) throw 0; url = new URL(location); }
  catch { fail('CALLBACK_FORMAT', '地址格式无效'); }
  if (url.protocol !== 'https:' || url.hostname !== 'y.qq.com' || url.port || url.username || url.password || url.pathname !== '/portal/wx_redirect.html') {
    const protocol = ['http:','https:'].includes(url.protocol) ? url.protocol.slice(0,-1) : 'OTHER';
    const host = ({ 'y.qq.com': 'QQ_MUSIC', 'graph.qq.com': 'QQ_CONNECT', 'ssl.ptlogin2.qq.com': 'QQ_LOGIN' })[url.hostname] || 'OTHER';
    const path = ({ '/portal/wx_redirect.html': 'MUSIC_CALLBACK', '/portal/wx_redirect.html/': 'MUSIC_CALLBACK_SLASH', '/oauth2.0/authorize': 'AUTHORIZE', '/oauth2.0/login_jump': 'LOGIN_JUMP', '/oauth2.0/error': 'AUTH_ERROR', '/oauth2.0/show': 'AUTH_SCREEN', '/oauth/show': 'AUTH_SCREEN' })[url.pathname] || 'OTHER';
    fail('CALLBACK_ADDRESS', `地址不符；${protocol}/${host}/${path}；额外端口=${!!url.port}，身份字段=${!!(url.username || url.password)}`);
  }
  const fragment = new URLSearchParams(url.hash.slice(1).replace(/^\?/, ''));
  const values = key => [...url.searchParams.getAll(key), ...fragment.getAll(key)];
  if (values('error').length || values('error_code').length) fail('PROVIDER_REJECTED', '平台返回授权错误');
  const states = values('state'), codes = values('code');
  if (states.length > 1 || codes.length > 1) fail('DUPLICATE_PARAMS', '回调参数重复');
  if (!states.length) fail('STATE_MISSING', '平台未回传校验参数');
  if (states[0] !== expectedState) fail('STATE_MISMATCH', '会话校验参数不一致');
  if (!codes.length) fail('CODE_MISSING', '平台未回传授权码');
  // Authorization codes are opaque values, not account names or Cookie fields.
  if (!/^[\x21-\x7e]{8,1000}$/.test(codes[0])) fail('CODE_FORMAT', '授权码格式不受支持');
  return codes[0];
}
export function parseQQCallback(body) {
  const match = /^\s*ptuiCB\(([\s\S]*)\);?\s*$/.exec(body);
  if (!match || body.length > 20000) throw new Error('QQ 扫码状态格式已变化。');
  const parts = [...match[1].matchAll(/'((?:\\.|[^'\\])*)'/g)], gaps = match[1].replace(/'((?:\\.|[^'\\])*)'/g, '').replace(/\s/g, '');
  if (parts.length < 5 || parts.length > 8 || gaps !== ','.repeat(parts.length - 1)) throw new Error('QQ 扫码状态格式已变化。');
  return parts.map(part => part[1].replace(/\\([\\/'"])/g, '$1').replace(/\\x([a-f0-9]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))).replace(/\\u([a-f0-9]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))));
}
function cookies(headers, allowed) {
  const result = new Map();
  for (const line of headers.getSetCookie()) {
    const first = line.split(';', 1)[0], at = first.indexOf('='), name = first.slice(0, at), value = first.slice(at + 1);
    if (at > 0 && /^[a-zA-Z0-9_]{1,80}$/.test(name) && (allowed === null || allowed.includes(name)) && /^[^\s;\r\n]{1,4096}$/.test(value) && result.size < 40) result.set(name, value);
  }
  return result;
}
function image(bytes) {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (!png && !jpeg) throw new Error('官方接口未返回有效二维码图片。');
  return `data:image/${png ? 'png' : 'jpeg'};base64,${bytes.toString('base64')}`;
}
export class QQLogin {
  constructor({ transport, exchange, adopt, wait = async () => {} }) {
    this.transport = transport; this.exchange = exchange; this.adopt = adopt; this.wait = wait;
    this.flow = null; this.controllers = new Set(); this.generation = 0;
  }
  cancel() { this.generation++; this.flow = null; for (const controller of this.controllers) controller.abort(); }
  async http(endpoint, { params = {}, form, cookie = '', flow, uuid } = {}) {
    if (flow && this.flow !== flow) throw new Error('二维码已取消，请重新生成。');
    if (endpoint !== 'wxImage' && !Object.hasOwn(endpoints, endpoint)) throw new Error('扫码接口不在允许列表。');
    const url = endpoint === 'wxImage' && /^[a-zA-Z0-9_-]{8,100}={0,2}$/.test(uuid || '') ? new URL('https://open.weixin.qq.com/connect/qrcode/' + encodeURIComponent(uuid)) : new URL(endpoints[endpoint] || 'about:blank');
    if (url.protocol !== 'https:') throw new Error('扫码接口不在允许列表。');
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const controller = new AbortController(); this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 18000);
    try {
      const response = await this.transport(url.href, { method: form ? 'POST' : 'GET', redirect: 'manual', signal: controller.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: endpoint.startsWith('wx') ? 'https://open.weixin.qq.com/' : endpoint === 'qqAuthorize' ? 'https://graph.qq.com/' : 'https://xui.ptlogin2.qq.com/', ...(cookie ? { Cookie: cookie } : {}), ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded', Origin: 'https://graph.qq.com' } : {}) },
        ...(form ? { body: new URLSearchParams(form).toString() } : {}) });
      if (flow && this.flow !== flow) throw new Error('二维码已取消，请重新生成。');
      if (!response.ok && ![301,302,303].includes(response.status)) throw new Error('官方扫码请求未完成，请稍后重新生成。');
      const chunks = []; let size = 0;
      for await (const chunk of response.body || []) { size += chunk.length; if (size > 300000) throw new Error('官方扫码响应过大，已停止。'); chunks.push(Buffer.from(chunk)); }
      return { headers: response.headers, status: response.status, bytes: Buffer.concat(chunks) };
    } catch (error) {
      if (flow && this.flow !== flow) throw new Error('二维码已取消，请重新生成。');
      if (controller.signal.aborted && endpoint === 'wxStatus') return { waiting: true };
      if (error.message?.startsWith('官方')) throw error;
      throw new Error('扫码请求网络失败或超时，请检查网络后重新生成。');
    } finally { clearTimeout(timeout); this.controllers.delete(controller); }
  }
  async create(mode = 'qq') {
    if (!['qq','wx'].includes(mode)) throw new Error('请选择 QQ 或微信扫码。');
    this.cancel(); const generation = this.generation;
    const flow = { mode, state: randomBytes(16).toString('hex'), expires: Date.now() + 180000, next: 0, checking: false };
    this.flow = flow;
    try {
      let result;
      if (mode === 'qq') {
        result = await this.http('qqImage', { flow, params: { appid: '716027609', e: 2, l: 'M', s: 3, d: 72, v: 4, t: Math.random(), daid: 383, pt_3rd_aid: '100497308' } });
        flow.qrsig = cookies(result.headers, ['qrsig']).get('qrsig');
        if (!/^[a-zA-Z0-9_*.-]{8,512}$/.test(flow.qrsig || '')) throw new Error('QQ 未返回有效二维码会话。');
      } else {
        const page = await this.http('wxPage', { flow, params: { appid: 'wx48db31d50e334801', redirect_uri: redirect('wx'), response_type: 'code', scope: 'snsapi_login', state: flow.state } });
        const html = page.bytes.toString();
        flow.uuid = /src=["']\/connect\/qrcode\/([a-zA-Z0-9_-]{8,100}={0,2})["']/.exec(html)?.[1] || /uuid\s*[:=]\s*["']([a-zA-Z0-9_-]{8,100}={0,2})["']/.exec(html)?.[1];
        if (!flow.uuid) throw new Error('微信未返回有效二维码会话。');
        result = await this.http('wxImage', { flow, uuid: flow.uuid });
      }
      if (generation !== this.generation || this.flow !== flow) throw new Error('二维码已取消，请重新生成。');
      return { image: image(result.bytes), type: mode, expiresAt: flow.expires, pollInterval: 3500 };
    } catch (error) { if (this.flow === flow) this.cancel(); throw error; }
  }
  async check() {
    const flow = this.flow;
    if (!flow) throw new Error('请先生成二维码。');
    if (Date.now() >= flow.expires) { this.cancel(); return { code: 800 }; }
    if (flow.checking || Date.now() < flow.next) throw new Error('扫码状态检查至少间隔 3 秒。');
    flow.next = Date.now() + 3000; flow.checking = true;
    try {
      let code;
      if (flow.mode === 'qq') {
        const response = await this.http('qqStatus', { flow, cookie: 'qrsig=' + flow.qrsig, params: { u1: 'https://graph.qq.com/oauth2.0/login_jump', ptqrtoken: hash(flow.qrsig), ptredirect: 0, h: 1, t: 1, g: 1, from_ui: 1, ptlang: 2052, action: '0-0-' + Date.now(), js_ver: '20102616', js_type: 1, pt_uistyle: 40, aid: '716027609', daid: 383, pt_3rd_aid: '100497308', has_onekey: 1 } });
        const args = parseQQCallback(response.bytes.toString());
        code = { 66: 801, 67: 802, 65: 800, 68: 804, 0: 803 }[args[0]];
        if (code === 803) return await this.finish(flow, await this.qqAuthorize(flow, args[2]));
      } else {
        const response = await this.http('wxStatus', { flow, params: { uuid: flow.uuid, _: Date.now() } });
        if (response.waiting) return { code: 801, waiting: true };
        const text = response.bytes.toString(), match = /window\.wx_errcode\s*=\s*(\d+);\s*window\.wx_code\s*=\s*'([^']*)'/.exec(text);
        if (!match) throw new Error('微信扫码状态格式已变化。');
        code = { 408: 801, 404: 802, 402: 800, 403: 804, 405: 803 }[match[1]];
        if (code === 803) {
          if (!token(match[2])) throw new Error('微信未返回有效授权码。');
          return await this.finish(flow, await this.exchange('wx', { code: match[2], strAppid: 'wx48db31d50e334801' }));
        }
      }
      if (code === undefined) { this.cancel(); throw new Error('平台拒绝扫码，请在官方客户端检查后重新生成。'); }
      if (code === 800 || code === 804) this.cancel();
      return { code };
    } catch (error) { if (this.flow === flow) this.cancel(); throw error; }
    finally { flow.checking = false; }
  }
  async qqAuthorize(flow, location) {
    let callback; try { callback = new URL(location); } catch { throw new Error('QQ 未返回有效授权地址。'); }
    if (callback.protocol !== 'https:' || callback.username || callback.password || callback.port || !['ssl.ptlogin2.qq.com','ptlogin2.qq.com','ssl.ptlogin2.graph.qq.com'].includes(callback.hostname) || callback.pathname !== '/check_sig') throw new Error('QQ 授权地址不在允许范围，已停止。');
    const uin = callback.searchParams.get('uin'), sig = callback.searchParams.get('ptsigx');
    if (!/^[1-9]\d{0,19}$/.test(uin || '') || !token(sig)) throw new Error('QQ 未返回完整授权凭据。');
    const ticket = await this.http('qqTicket', { flow, params: { uin, pttype: 1, service: 'ptqrlogin', nodirect: 0, ptsigx: sig, s_url: 'https://graph.qq.com/oauth2.0/login_jump', ptlang: 2052, ptredirect: 100, aid: '716027609', daid: 383, j_later: 0, low_login_hour: 0, regmaster: 0, pt_login_type: 3, pt_aid: 0, pt_aaid: 16, pt_light: 0, pt_3rd_aid: '100497308' } });
    // Only cookies issued by this HTTPS check_sig request are used; no browser
    // cookie jar is read. Keep required handshake fields for the fixed OAuth host.
    const jar = cookies(ticket.headers, null);
    if (!jar.has('p_skey')) throw new Error('QQ 授权未取得会话，请在手机确认后重新生成。');
    await this.wait(500);
    const auth = await this.http('qqAuthorize', { flow, cookie: [...jar].map(([name,value]) => name + '=' + value).join('; '), form: { response_type: 'code', client_id: '100497308', redirect_uri: redirect('qq'), scope: 'get_user_info', openapi: '1010', state: flow.state, switch: '', from_ptlogin: 1, src: 1, update_auth: 1, g_tk: hash(jar.get('p_skey'), 5381), auth_time: Date.now(), ui: randomBytes(16).toString('hex') } });
    const code = parseQQOAuthRedirect(auth.headers.get('location'), flow.state);
    return this.exchange('qq', { code });
  }
  async finish(flow, data) {
    if (this.flow !== flow || Date.now() >= flow.expires) throw new Error('二维码已取消或过期，请重新生成。');
    this.cancel(); return this.adopt(data, flow.mode);
  }
}
