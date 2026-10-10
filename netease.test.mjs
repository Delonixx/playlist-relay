import test from 'node:test';
import assert from 'node:assert/strict';
import { Netease } from './netease.mjs';
const result = (body, cookies = []) => new Response(JSON.stringify(body), { status: 200, headers: cookies.map(cookie => ['set-cookie', cookie]) });

test('QR uses upstream EAPI protocol, preserves handshake and separates authorization from account verification', async () => {
  const requests = [], responses = [ result({ code: 200, unikey: 'test-key' }, ['NMTID=handshake; Path=/']), result({ code: 803 }, ['MUSIC_U=test-session; HttpOnly', '__csrf=test-csrf; Path=/']), result({ code: 8821 }), result({ code: 200, profile: { userId: 42, nickname: '测试用户' } }) ];
  const api = new Netease({ wait: async () => {}, transport: async (url, options) => { requests.push({ url, options }); return responses.shift(); } });
  const qr = await api.qr(); assert.match(qr.image, /^data:image\/png;base64,/);
  const checked = await api.qrCheck(); assert.equal(checked.code, 803); assert.equal(checked.authorized, true); assert.equal(checked.user, null); assert.match(checked.warning, /账号资料验证.*8821/);
  assert.equal(api.sessionInfo().hasSession, true); assert.equal(api.sessionInfo().verified, false); assert.match(api.cookie, /MUSIC_U=test-session/);
  assert.equal(requests[0].url, 'https://interfacepc.music.163.com/eapi/login/qrcode/unikey');
  assert.match(requests[1].options.headers.Cookie, /NMTID=handshake/); assert.match(requests[1].options.headers.Cookie, /deviceId=/);
  assert.equal((await api.user()).id, '42'); assert.equal(api.sessionInfo().verified, true);
  assert.ok(requests[2].url.includes('/eapi/w/nuser/account/get')); assert.equal(JSON.stringify(api.sessionInfo()).includes('test-session'), false);
});
test('QR checks are throttled on server and expired keys cannot be reused', async () => {
  let calls = 0;
  const responses = [result({ code: 200, unikey: 'test-key' }), result({ code: 801 }), result({ code: 800 })];
  const api = new Netease({ wait: async () => {}, transport: async () => { calls++; return responses.shift(); } });
  await api.qr(); await api.qrCheck(); await assert.rejects(api.qrCheck(), /3 秒/); assert.equal(calls, 2);
  api.nextQrCheck = 0; await api.qrCheck(); await assert.rejects(api.qrCheck(), /生成二维码/);
});
test('Cookie verification stays on working WEAPI path and failed replacement restores previous session', async () => {
  const requests = [];
  const api = new Netease({ wait: async () => {}, transport: async (url) => { requests.push(url); return result({ code: requests.length === 1 ? 200 : 8821, profile: { userId: 42, nickname: '测试用户' } }); } });
  await api.setCookie('MUSIC_U=first-session; __csrf=test');
  await assert.rejects(api.setCookie('MUSIC_U=invalid-session'), /8821/);
  assert.match(api.cookie, /first-session/); assert.equal(api.sessionInfo().verified, true); assert.equal(api.sessionInfo().source, 'cookie');
  assert.ok(requests.every(url => url.includes('/weapi/w/nuser/account/get')));
  api.clear(); assert.equal(api.sessionInfo().hasSession, false);
});
