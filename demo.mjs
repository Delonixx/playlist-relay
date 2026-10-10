export class Demo {
  constructor({ platform = 'netease' } = {}) { this.platform = platform; this.ids = ['101']; this.cookie = ''; }
  capabilities() { return { qr: true, qrTypes: this.platform === 'qq' ? ['qq','wx'] : [], autoQr: this.platform === 'qq', create: true, privateCreate: this.platform !== 'qq', favorites: this.platform === 'qq', experimental: this.platform === 'qq' }; }
  async favoriteCounts(ids) { if (this.platform !== 'qq') throw new Error('当前平台未提供收藏数。'); return Object.fromEntries(ids.map(id => [id, Number(id) % 10000])); }
  playlistUrl(id) { return this.platform === 'qq' ? `https://y.qq.com/n/ryqq/playlist/${id}` : `https://music.163.com/playlist?id=${id}`; }
  async user() { return { id: 'demo', name: '演示账号（未连接音乐平台）' }; }
  async setCookie() { throw new Error('演示模式不接收 Cookie'); }
  async qr() { throw new Error('演示模式无需扫码'); }
  async qrCheck() { throw new Error('演示模式无需扫码'); }
  async playlists() { return [{ id: '90001', name: '演示歌单', count: this.ids.length }]; }
  async search(row) {
    if (/missing|找不到/i.test(row.title)) return [];
    const id = String(100 + [...row.title].reduce((s, c) => s + c.codePointAt(0), 0));
    return [{ id, platform: this.platform, name: row.title, ar: [{ name: row.artist || '未知歌手' }], al: { name: '演示专辑' }, dt: 210000 }, { id: String(+id + 10000), platform: this.platform, name: row.title + ' (Live)', ar: [{ name: row.artist || '未知歌手' }], al: { name: '演示现场版' } }];
  }
  async detail(id) { return { id, name: '演示歌单', creator: { userId: 'demo' }, trackIds: this.ids.map(id => ({ id })) }; }
  async create(name) { this.ids = []; return { id: '90002', name }; }
  async readPlaylist(id) {
    return { id: String(id), title: '演示歌单', total: 6, sampled: false, tracks: [
      { title: "That's Enough for Me", artist: 'Patti Austin', album: 'End of a Rainbow', year: 1976 },
      { title: "If I Ain't Got You", artist: 'Alicia Keys', album: 'The Diary of Alicia Keys', year: 2003 },
      { title: 'So Sick', artist: 'Ne-Yo', album: 'In My Own Words', year: 2006 },
      { title: 'Sweet Love', artist: 'Anita Baker', album: 'Rapture', year: 1986 },
      { title: 'On & On', artist: 'Erykah Badu', album: 'Baduizm', year: 1997 },
      { title: 'Ascension (Don’t Ever Wonder)', artist: 'Maxwell', album: "Maxwell's Urban Hang Suite", year: 1996 }
    ] };
  }
  async add(pid, ids) { this.ids = [...new Set([...this.ids, ...ids])]; }
  async pause() {}
  clear() {}
}
