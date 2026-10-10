import test from 'node:test';
import assert from 'node:assert/strict';
import { QQMusic, parseQQCookie, qqSong } from './qq.mjs';
import { appendVerified } from './core.mjs';

const cookie = 'uin=o000123; qqmusic_key=local-dummy; unrelated=do-not-forward';
const rawSong = (id, title = 'Song') => ({ id, type: 1, name: 'Song', title, singer: [{ name: 'Artist' }], album: { name: 'Album', pmid: 'album_5', mid: 'album' }, interval: 200 });
const playlist = (songs, { total = songs.length, owner = '123', hasmore = false, id = 90001 } = {}) => ({ total_song_num: total, hasmore, songlist: songs, dirinfo: { id, dirid: 2, title: 'My playlist', creator: { musicid: owner } } });
function fixture(handler = () => ({})) {
  const calls = [];
  const api = new QQMusic({ wait: async () => {}, transport: async (url, options) => {
    const body = JSON.parse(options.body); calls.push({ url, options, body });
    const data = await handler(body.req.method, body.req.param, calls.length);
    return new Response(JSON.stringify(data?.envelope || { code: 0, req: { code: 0, data } }));
  }});
  return { api, calls };
}
const login = method => method === 'GetLoginUserInfo' ? { info: { nick: 'Local fixture', musicid: 123 } } : null;

test('QQ Cookie is locally parsed, forwards only music credentials and restores a working session on verification failure', async () => {
  assert.equal(parseQQCookie(cookie).id, '123');
  assert.equal(parseQQCookie('login_type=2; wxuin=987; qqmusic_key=local-dummy').id, '987');
  assert.throws(() => parseQQCookie('uin=123; qqmusic_key=x\r\nInjected=1'));
  let fail = false;
  const { api, calls } = fixture(() => fail ? { info: { musicid: 999, nick: 'Other' } } : { info: { nick: 'Local fixture' } });
  await api.setCookie(cookie); api.directories.set('90001', 2);
  assert.equal(calls[0].url, 'https://u.y.qq.com/cgi-bin/musicu.fcg');
  assert.equal(calls[0].options.headers.Cookie.includes('unrelated'), false);
  fail = true; await assert.rejects(api.setCookie('uin=456; qqmusic_key=replacement-dummy'), /身份/);
  assert.equal(api.credential.id, '123'); assert.equal(api.verified, true); assert.equal(api.directories.get('90001'), 2);
  api.clear(); assert.equal(api.sessionInfo().hasSession, false); assert.equal(api.directories.size, 0);
});

test('QQ search preserves Live titles and suffixed cover IDs; anonymous queries never carry credentials', async () => {
  const { api, calls } = fixture(method => login(method) || { body: { item_song: { items: [rawSong(1), rawSong(2, 'Song (Live)')] } } });
  await api.setCookie(cookie);
  const songs = await api.search({ title: 'Song', artist: 'Artist' });
  assert.equal(songs[1].name, 'Song (Live)'); assert.match(songs[0].al.picUrl, /album_5\.jpg$/);
  assert.equal(calls[1].options.headers.Cookie, undefined);
  assert.equal(calls[1].body.req.method, 'do_search_v2'); assert.equal(calls[1].body.comm.uin, '0');
  await assert.rejects(api.request('delete'), /允许列表/); assert.equal(calls.length, 2);
});

test('QQ favorite buckets are never represented as exact people; missing or unparseable displays remain unknown', async () => {
  const { api, calls } = fixture(() => ({ m_numbers: { 1: 1000001, 2: 1000001, 3: 99 }, m_show: { 1: '5700w+', 2: '340w+', 3: 'unknown' } }));
  const counts = await api.favoriteCounts(['1', '2', '3']);
  assert.deepEqual(counts['1'], { value: 57000000, display: '5700w+', approximate: true });
  assert.equal(counts['2'].value, 3400000); assert.equal(counts['3'], undefined);
  assert.deepEqual(await api.favoriteCounts([]), {}); assert.equal(calls.length, 1);
});

test('QQ checks outer, RPC and business refusals and never retries a rejected write', async () => {
  for (const envelope of [{ code: 80105 }, { code: 0, req: { code: 80105, data: {} } }, { code: 0, req: { code: 0, data: { retCode: 80105 } } }, { code: 0, req: { code: 0, data: { subcode: 80105 } } }]) {
    const { api, calls } = fixture(() => ({ envelope }));
    api.credential = parseQQCookie(cookie); api.verified = true; api.directories.set('90001', 2); api.songTypes.set('1', 1);
    await assert.rejects(api.add('90001', ['1']), /80105/); assert.equal(calls.length, 1);
  }
});

test('QQ validates every playlist page, refuses incomplete readback and does not authorize another owner', async () => {
  const tracks = Array.from({ length: 101 }, (_, i) => rawSong(i + 1));
  const { api, calls } = fixture((method, param) => login(method) || playlist(tracks.slice(param.song_begin, param.song_begin + 100), { total: 101, hasmore: param.song_begin === 0 }));
  await api.setCookie(cookie); const result = await api.detail('90001');
  assert.equal(result.trackIds.length, 101); assert.equal(api.directories.get('90001'), 2);
  assert.deepEqual(calls.slice(1).map(value => value.body.req.param.song_begin), [0, 100]);
  const other = fixture(method => login(method) || playlist([rawSong(1)], { owner: '456' }));
  await other.api.setCookie(cookie); await other.api.detail('90001');
  await assert.rejects(other.api.add('90001', ['1']), /自己的/);
  const incomplete = fixture(method => login(method) || playlist([rawSong(1)], { total: 2 }));
  await incomplete.api.setCookie(cookie); await assert.rejects(incomplete.api.detail('90001'), /不完整/);
  assert.equal(incomplete.api.directories.has('90001'), false);
});

test('QQ refuses silently public creation, guessed song types and ambiguous business success', async () => {
  assert.throws(() => qqSong({ ...rawSong(1), type: undefined }), /格式无效/);
  assert.throws(() => qqSong({ ...rawSong(1), id: Number.MAX_SAFE_INTEGER + 1 }), /不精确/);
  const { api, calls } = fixture(method => login(method) || { result: { tid: 90001, dirId: 2 } });
  await api.setCookie(cookie); await assert.rejects(api.create('Test', '10'), /私密/); assert.equal(calls.length, 1);
  await assert.rejects(api.create('Test', '0'), /确认创建/);
  api.directories.set('90001', 2); await assert.rejects(api.add('90001', ['1']), /已搜索到/);
  assert.equal(calls.length, 2);
  api.rememberSong({ id: '1', songType: 1 }); api.rememberSong({ id: '1', songType: 2 });
  await assert.rejects(api.add('90001', ['1']), /不同类型/); assert.equal(calls.length, 2);
});

test('QQ playlist types do not contaminate search; conflicting search IDs remain readable but cannot be written', async () => {
  const { api, calls } = fixture(method => {
    if (login(method)) return login(method);
    if (method === 'CgiGetDiss') return playlist([{ ...rawSong(1), type: 0 }]);
    return { body: { item_song: { items: [rawSong(1), { ...rawSong(2), type: 0 }, { ...rawSong(2), type: 1 }, rawSong(3)] } } };
  });
  await api.setCookie(cookie); await api.readPlaylist('90001');
  const songs = await api.search({ title: 'Song', artist: 'Artist' });
  assert.equal(songs.length, 3); assert.equal(songs[0].writeBlocked, false); assert.equal(songs[1].writeBlocked, true);
  assert.equal(api.songTypes.get('1'), 1);
  await assert.rejects(api.add('90001', ['2']), /不同类型/);
  assert.equal(calls.some(call => call.body.req.method === 'AddSonglist'), false);
  api.resetSearchTypes(); assert.equal(api.songTypes.size, 0);
});

test('QQ appends numeric song IDs with their actual types and confirms the batch by rereading the owned playlist', async () => {
  const songs = [rawSong(1)];
  const { api, calls } = fixture((method, param) => {
    if (login(method)) return login(method);
    if (method === 'CgiGetDiss') return playlist(songs);
    if (method === 'AddSonglist') { assert.deepEqual(param.v_songInfo, [{ songId: 2, songType: 1 }]); songs.push(rawSong(2)); return { retCode: 0 }; }
    throw new Error('Unexpected method');
  });
  await api.setCookie(cookie); api.rememberSong({ id: '2', songType: 1 });
  const report = await appendVerified(api, '90001', '123', ['1', '2']);
  assert.deepEqual(report.skipped, ['1']); assert.deepEqual(report.verified, ['2']); assert.equal(report.stopped, '');
  assert.equal(report.platform, 'qq'); assert.equal(report.url, 'https://y.qq.com/n/ryqq/playlist/90001');
  assert.equal(calls.filter(value => value.body.req.method === 'AddSonglist').length, 1);
});
