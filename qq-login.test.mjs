import test from 'node:test';
import assert from 'node:assert/strict';
import { QQLogin, parseQQCallback, parseQQOAuthRedirect } from './qq-login.mjs';
import { QQMusic } from './qq.mjs';

const png = Buffer.from([137,80,78,71,13,10,26,10]); // Signature fixture, not visual QR evidence.
const sig = 'local-qr-signature', code = 'local-authorize-code';
const response = (text, headers = {}, status = 200) => new Response(text, { headers, status });
const callback = (status, url = '') => `ptuiCB('${status}','0','${url}','0','local fixture','');`;
const successURL = 'https://ssl.ptlogin2.qq.com/check_sig?uin=123&ptsigx=local-ticket-signature';
function fixture(handler, exchange = async () => ({ musicid: 123, musickey: 'local-session-key' })) {
  const calls = [], adopted = [], exchanges = [];
  const login = new QQLogin({ wait: async () => {}, transport: async (url, options) => { calls.push({ url: new URL(url), options }); return handler(new URL(url), options, calls.length); },
    exchange: async (mode, param) => { exchanges.push({ mode, param }); return exchange(mode, param); },
    adopt: async (data, mode) => { adopted.push({ data, mode }); return { code: 803, authorized: true, user: { id: '123', name: 'Local fixture' } }; } });
  return { login, calls, adopted, exchanges };
}
const imageResponse = () => response(png, { 'set-cookie': 'qrsig=' + sig + '; Secure; HttpOnly' });

test('QQ OAuth parses both query and fragment response fields without weakening address or state checks', () => {
  const base = 'https://y.qq.com/portal/wx_redirect.html', state = 'local-state-value';
  for (const suffix of ['?code=local-code-value&state=' + state, '?login_type=1&surl=https%3A%2F%2Fy.qq.com%2F#code=local-code-value&state=' + state, '?state=' + state + '#code=local-code-value']) {
    assert.equal(parseQQOAuthRedirect(base + suffix, state), 'local-code-value');
  }
  assert.equal(parseQQOAuthRedirect(base + '?code=local%2Bcode%2Fvalue%3D&state=' + state, state), 'local+code/value=');
  assert.throws(() => parseQQOAuthRedirect(base + '?code=local-code-value#state=other-state', state), /STATE_MISMATCH/);
  assert.throws(() => parseQQOAuthRedirect('https://evil.test/portal/wx_redirect.html?code=local-code-value&state=' + state, state), /CALLBACK_ADDRESS/);
  assert.throws(() => parseQQOAuthRedirect(base + '?code=local-code-value&state=' + state + '#code=another-code', state), /DUPLICATE_PARAMS/);
});

test('QQ OAuth errors identify the failed field without exposing callback, code, state or credential values', () => {
  const base = 'https://y.qq.com/portal/wx_redirect.html', secret = 'do-not-reveal-this-value';
  for (const [suffix, expected] of [['?code=' + secret, 'STATE_MISSING'], ['?state=local-state', 'CODE_MISSING'], ['?state=' + secret + '&code=' + secret, 'STATE_MISMATCH'], ['?state=local-state&code=short', 'CODE_FORMAT'], ['?error_description=' + secret + '&error=100020', 'PROVIDER_REJECTED']]) {
    assert.throws(() => parseQQOAuthRedirect(base + suffix, 'local-state'), error => error.message.includes(expected) && !error.message.includes(secret) && !error.message.includes('https://'));
  }
});

test('QQ QR generates an image, preserves qrsig only in memory and maps waiting/confirmation without exchanging credentials', async () => {
  let status = 66;
  const { login, calls, exchanges } = fixture(url => url.pathname === '/ptqrshow' ? imageResponse() : response(callback(status)));
  const qr = await login.create(); assert.match(qr.image, /^data:image\/png;base64,/); assert.equal(JSON.stringify(qr).includes(sig), false);
  assert.equal((await login.check()).code, 801); status = 67; login.flow.next = 0; assert.equal((await login.check()).code, 802);
  assert.equal(calls[1].options.headers.Cookie, 'qrsig=' + sig); assert.equal(exchanges.length, 0);
  assert.equal(calls[0].options.redirect, 'manual'); login.cancel();
});

test('QQ QR enforces throttling, expiry and refusal; none of these states exchange or retain tickets', async () => {
  const { login, calls, exchanges } = fixture(url => url.pathname === '/ptqrshow' ? imageResponse() : response(callback(68)));
  await login.create(); login.flow.next = Date.now() + 3000; await assert.rejects(login.check(), /3 秒/); assert.equal(calls.length, 1);
  login.flow.next = 0; assert.equal((await login.check()).code, 804); assert.equal(login.flow, null);
  await login.create(); login.flow.expires = 0; assert.equal((await login.check()).code, 800);
  assert.equal(exchanges.length, 0);
});

test('QQ completes the allowlisted ticket/OAuth flow, validates state and exchanges the code once', async () => {
  const { login, calls, exchanges, adopted } = fixture((url, options) => {
    if (url.pathname === '/ptqrshow') return imageResponse();
    if (url.pathname === '/ptqrlogin') return response(callback(0, successURL));
    if (url.pathname === '/check_sig') return response('', { 'set-cookie': 'p_skey=local-ticket-key; Secure; HttpOnly' }, 302);
    const form = new URLSearchParams(options.body);
    assert.equal(form.get('scope'), 'get_user_info');
    assert.equal(form.get('openapi'), '1010'); assert.equal(options.headers.Origin, 'https://graph.qq.com'); assert.equal(options.headers.Referer, 'https://graph.qq.com/');
    return response('', { location: 'https://y.qq.com/portal/wx_redirect.html?code=' + code + '&state=' + form.get('state') }, 302);
  });
  await login.create(); const result = await login.check();
  assert.equal(result.authorized, true); assert.deepEqual(exchanges, [{ mode: 'qq', param: { code } }]); assert.equal(adopted.length, 1);
  assert.equal(calls[2].url.origin, 'https://ssl.ptlogin2.graph.qq.com'); assert.equal(calls[3].url.origin, 'https://graph.qq.com');
  assert.equal(calls[3].options.headers.Cookie, 'p_skey=local-ticket-key');
  assert.equal(JSON.stringify(result).includes('local-session-key'), false); await assert.rejects(login.check(), /生成二维码/);
});

test('QQ rejects an arbitrary ticket address or mismatched OAuth state before exchanging or adopting credentials', async () => {
  for (const wrongAddress of [true, false]) {
    const { login, exchanges, adopted, calls } = fixture((url, options) => {
      if (url.pathname === '/ptqrshow') return imageResponse();
      if (url.pathname === '/ptqrlogin') return response(callback(0, wrongAddress ? 'https://evil.test/check_sig?uin=123&ptsigx=local-ticket-signature' : successURL));
      if (url.pathname === '/check_sig') return response('', { 'set-cookie': 'p_skey=local-ticket-key; Secure' }, 302);
      return response('', { location: 'https://y.qq.com/portal/wx_redirect.html?code=' + code + '&state=wrong' }, 302);
    });
    await login.create(); await assert.rejects(login.check(), /允许范围|回调校验/);
    assert.equal(exchanges.length, 0); assert.equal(adopted.length, 0); assert.equal(login.flow, null);
    assert.equal(calls.some(value => value.url.hostname === 'evil.test'), false);
  }
});

test('QQ carries the current official ticket session into OAuth and keeps it out of returned account data', async () => {
  const { login, exchanges } = fixture((url, options) => {
    if (url.pathname === '/ptqrshow') return imageResponse();
    if (url.pathname === '/ptqrlogin') return response(callback(0, successURL));
    if (url.pathname === '/check_sig') {
      const headers = new Headers();
      headers.append('set-cookie', 'p_skey=local-ticket-key; Secure; HttpOnly');
      headers.append('set-cookie', 'p_uin=o123; Secure; HttpOnly');
      headers.append('set-cookie', 'pt_oauth_token=local-handshake-token; Secure; HttpOnly');
      return response('', headers, 302);
    }
    assert.equal(url.href, 'https://graph.qq.com/oauth2.0/authorize');
    assert.match(options.headers.Cookie, /pt_oauth_token=local-handshake-token/);
    assert.match(options.headers.Cookie, /p_uin=o123/);
    assert.equal(options.headers.Cookie.includes('qrsig='), false);
    const form = new URLSearchParams(options.body);
    return response('', { location: 'https://y.qq.com/portal/wx_redirect.html#code=' + code + '&state=' + form.get('state') }, 302);
  });
  await login.create(); const result = await login.check();
  assert.equal(exchanges.length, 1);
  assert.equal(JSON.stringify(result).includes('local-handshake-token'), false);
});

test('QQ authorization screens and unknown connect routes never become a successful music session or leak their parameters', async () => {
  for (const path of ['/oauth2.0/show', '/oauth/show', '/unknown-route']) {
    const { login, exchanges, adopted } = fixture((url) => {
      if (url.pathname === '/ptqrshow') return imageResponse();
      if (url.pathname === '/ptqrlogin') return response(callback(0, successURL));
      if (url.pathname === '/check_sig') return response('', { 'set-cookie': 'p_skey=local-ticket-key; Secure' }, 302);
      return response('', { location: 'https://graph.qq.com' + path + '?code=do-not-expose&state=do-not-expose' }, 302);
    });
    await login.create();
    await assert.rejects(login.check(), error => error.message.includes('QQ_CONNECT/' + (path === '/unknown-route' ? 'OTHER' : 'AUTH_SCREEN')) && !error.message.includes('do-not-expose') && !error.message.includes('https://'));
    assert.equal(exchanges.length, 0); assert.equal(adopted.length, 0); assert.equal(login.flow, null);
  }
});

test('WX QR uses the observed image src, maps mobile confirmation and exchanges its own code', async () => {
  let status = 404;
  const { login, calls, exchanges } = fixture(url => {
    if (url.pathname === '/connect/qrconnect') return response('<img src="/connect/qrcode/local-wx-uuid="/>');
    if (url.pathname.startsWith('/connect/qrcode/')) return response(png);
    return response(`window.wx_errcode=${status};window.wx_code='${status === 405 ? code : ''}';`);
  });
  const qr = await login.create('wx'); assert.equal(qr.type, 'wx'); assert.equal((await login.check()).code, 802);
  status = 405; login.flow.next = 0; assert.equal((await login.check()).authorized, true);
  assert.deepEqual(exchanges, [{ mode: 'wx', param: { code, strAppid: 'wx48db31d50e334801' } }]);
  assert.ok(calls.every(value => !value.options.headers.Cookie)); assert.equal(calls[2].url.origin, 'https://lp.open.weixin.qq.com');
});

test('QQ/WX parsing never executes returned JavaScript and refuses non-image QR content', async () => {
  assert.throws(() => parseQQCallback("ptuiCB('0','0','','0','x');globalThis.unsafe=true;"), /格式/);
  assert.throws(() => parseQQCallback("ptuiCB('0',()=>globalThis.unsafe=true,'x','x','x');"), /格式/);
  const { login } = fixture(() => response('<svg onload="unsafe()"/>', { 'set-cookie': 'qrsig=' + sig }));
  await assert.rejects(login.create(), /有效二维码图片/); assert.equal(login.flow, null);
});

test('canceling or replacing a QR during a late code exchange never adopts its session', async () => {
  let release, entered;
  const pending = new Promise(resolve => { release = resolve; }), started = new Promise(resolve => { entered = resolve; });
  const { login, adopted } = fixture(url => {
    if (url.pathname === '/connect/qrconnect') return response('<img src="/connect/qrcode/local-wx-uuid"/>');
    if (url.pathname.startsWith('/connect/qrcode/')) return response(png);
    return response(`window.wx_errcode=405;window.wx_code='${code}';`);
  }, async () => { entered(); return pending; });
  await login.create('wx'); const oldCheck = login.check(); await started; login.cancel();
  release({ musicid: 123, musickey: 'local-session-key' }); await assert.rejects(oldCheck, /取消或过期/); assert.equal(adopted.length, 0);
});

test('QQ music QR session separates authorization from account validation and never exposes the music key', async () => {
  let reject = true;
  const api = new QQMusic({ wait: async () => {}, transport: async () => response(JSON.stringify({ code: 0, req: { code: reject ? 1000 : 0, data: { info: { nick: 'Local fixture', musicid: 123 } } } })) });
  const result = await api.adoptQR({ musicid: 123, musickey: 'local-session-key' }, 'qq');
  assert.equal(result.authorized, true); assert.equal(result.user, null); assert.equal(api.sessionInfo().source, 'qr'); assert.equal(api.sessionInfo().verified, false);
  assert.equal(JSON.stringify(result).includes('local-session-key'), false);
  reject = false; assert.equal((await api.user()).id, '123'); assert.equal(api.sessionInfo().verified, true); api.clear();
});

test('canceling a WX long poll aborts the transport instead of treating cancellation as waiting', async () => {
  let entered, aborted = false;
  const started = new Promise(resolve => { entered = resolve; });
  const { login, adopted } = fixture((url, options) => {
    if (url.pathname === '/connect/qrconnect') return response('<img src="/connect/qrcode/local-wx-uuid"/>');
    if (url.pathname.startsWith('/connect/qrcode/')) return response(png);
    entered(); return new Promise((resolve, reject) => { options.signal.addEventListener('abort', () => { aborted = true; reject(new Error('abort')); }); });
  });
  await login.create('wx'); const pending = login.check(); await started; login.cancel();
  await assert.rejects(pending, /取消/); assert.equal(aborted, true); assert.equal(adopted.length, 0); assert.equal(login.controllers.size, 0);
});
