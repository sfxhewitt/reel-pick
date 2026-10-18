// Unit tests for plex.js with an in-memory storage and a fake fetch (no network).
const test = require('node:test'), assert = require('node:assert');
const PC = require('../plex.js');
const mem = () => { const m = new Map(); return { getItem: k => m.has(k) ? m.get(k) : null, setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m }; };
const res = (body, status = 200) => ({ ok: status < 400, status, headers: { get: () => 'application/json' }, json: async () => body, text: async () => JSON.stringify(body) });

test('guid parsing handles new and legacy agents', () => {
  assert.deepStrictEqual(PC.idsFromGuids({ Guid: [{ id: 'imdb://tt0133093' }, { id: 'tmdb://603' }, { id: 'tvdb://1' }] }), { tmdb: [603], imdb: ['tt0133093'] });
  assert.deepStrictEqual(PC.idsFromGuids({ guid: 'com.plexapp.agents.themoviedb://27205?lang=en' }), { tmdb: [27205], imdb: [] });
  assert.deepStrictEqual(PC.idsFromGuids({ guid: 'com.plexapp.agents.imdb://tt1375666?lang=en' }), { tmdb: [], imdb: ['tt1375666'] });
});
test('connections: https only, local, then remote, then relay', () => {
  const o = PC.orderConnections([
    { protocol: 'https', uri: 'https://relay.plex.direct:8443', relay: true, local: false },
    { protocol: 'http', uri: 'http://192.168.1.5:32400', local: true },
    { protocol: 'https', uri: 'https://1-2-3-4.x.plex.direct:32400', local: false },
    { protocol: 'https', uri: 'https://192-168-1-5.x.plex.direct:32400', local: true }]);
  assert.deepStrictEqual(o.map(c => c.uri), ['https://192-168-1-5.x.plex.direct:32400', 'https://1-2-3-4.x.plex.direct:32400', 'https://relay.plex.direct:8443']);
});
test('owned servers only', () => {
  const r = PC.ownedServers([{ name: 'A', owned: true, provides: 'server' }, { name: 'B', owned: false, provides: 'server' }, { name: 'C', owned: true, provides: 'client,player' }]);
  assert.deepStrictEqual(r.map(x => x.name), ['A']);
});
test('auth url carries client id, code, product and forwardUrl', () => {
  const u = PC.authUrl('cid-1', 'abc', 'https://x.github.io/reel-pick/#plexauth');
  assert.ok(u.startsWith('https://app.plex.tv/auth#?'));
  const q = new URLSearchParams(u.split('#?')[1]);
  assert.strictEqual(q.get('clientID'), 'cid-1'); assert.strictEqual(q.get('code'), 'abc');
  assert.strictEqual(q.get('context[device][product]'), 'Reel Pick'); assert.strictEqual(q.get('forwardUrl'), 'https://x.github.io/reel-pick/#plexauth');
  assert.ok(u.includes('Reel%20Pick'));
});
test('pin flow -> token stored only in storage, client id stable', async () => {
  const st = mem(); let polls = 0; const seen = [];
  const fetch = async (url, o) => { seen.push([o.method, url, o.headers]);
    if (url.includes('/pins?strong=true')) return res({ id: 7, code: 'c0de', expiresIn: 1800 });
    if (url.includes('/pins/7')) return res({ id: 7, authToken: ++polls >= 2 ? 'TOKEN-123' : null });
    if (url.endsWith('/user')) return res({ friendlyName: 'Rust' });
    if (url.includes('watchlist')) return res({ MediaContainer: { totalSize: 0, Metadata: [] } });
    if (url.includes('resources')) return res([]);
    return res({}, 404); };
  const p = PC.create({ storage: st, fetch });
  const cid = p.clientId; assert.ok(cid && st.getItem('reelpick.plex.cid') === cid);
  assert.strictEqual(PC.create({ storage: st, fetch }).clientId, cid, 'client id is stable');
  const pin = await p.preparePin(); assert.strictEqual(p.pendingPin(), null, 'prepared pin is not "waiting"');
  p.begin(pin); assert.ok(p.pendingPin());
  assert.strictEqual(await p.checkPin(), false); assert.strictEqual(await p.checkPin(), true);
  assert.ok(p.signedIn); assert.strictEqual(p.user.name, 'Rust');
  assert.strictEqual(JSON.parse(st.getItem('reelpick.plex.auth')).token, 'TOKEN-123');
  assert.ok(seen.every(([, url]) => !url.includes('TOKEN-123')), 'token never in a URL');
  assert.ok(seen.filter(([, u]) => u.includes('/pins')).every(([, , h]) => !h['X-Plex-Token'] && h['X-Plex-Product'] === 'Reel Pick' && h['X-Plex-Client-Identifier'] === cid));
  p.signOut(); assert.ok(!p.signedIn); assert.strictEqual(st.getItem('reelpick.plex.auth'), null);
});
test('watchlist toggle uses discover matches + PUT actions', async () => {
  const st = mem(); st.setItem('reelpick.plex.auth', JSON.stringify({ token: 'T' })); const calls = [];
  const fetch = async (url, o) => { calls.push(o.method + ' ' + url.replace('https://discover.provider.plex.tv', ''));
    if (url.includes('/watchlist/all')) return res({ MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: 'rk-inc', Guid: [{ id: 'tmdb://27205' }] }] } });
    if (url.includes('/matches')) return res({ MediaContainer: { Metadata: [{ ratingKey: 'rk-mat' }] } });
    if (url.includes('/actions/')) return res({});
    return res({}, 404); };
  const p = PC.create({ storage: st, fetch });
  await p.refreshWatchlist(true);
  assert.ok(p.onWatchlist(27205)); assert.ok(!p.onWatchlist(603));
  await p.setWatchlist(603, true); assert.ok(p.onWatchlist(603));
  await p.setWatchlist(603, false); assert.ok(!p.onWatchlist(603));
  await p.setWatchlist(27205, false); assert.ok(!p.onWatchlist(27205));
  assert.ok(calls.includes('GET /library/metadata/matches?type=1&guid=tmdb%3A%2F%2F603'));
  assert.ok(calls.includes('PUT /actions/addToWatchlist?ratingKey=rk-mat') && calls.includes('PUT /actions/removeFromWatchlist?ratingKey=rk-mat') && calls.includes('PUT /actions/removeFromWatchlist?ratingKey=rk-inc'));
  assert.strictEqual(calls.filter(c => c.includes('/matches')).length, 1, 'match cached');
});
test('library: picks reachable https connection, builds tmdb/imdb sets, falls back to stale copy', async () => {
  const st = mem(); st.setItem('reelpick.plex.auth', JSON.stringify({ token: 'T' })); let down = false; const tried = [];
  const server = { name: 'Box', owned: true, provides: 'server', clientIdentifier: 'mid1', accessToken: 'ST',
    connections: [{ protocol: 'https', uri: 'https://10-0-0-2.h.plex.direct:32400', local: true }, { protocol: 'https', uri: 'https://81-2-3-4.h.plex.direct:32400', local: false }, { protocol: 'http', uri: 'http://10.0.0.2:32400', local: true }] };
  const fetch = async (url, o) => {
    if (url.includes('resources')) return res([server]);
    if (url.includes('/identity')) { tried.push(url); if (down || url.includes('10-0-0-2')) throw new TypeError('Failed to fetch'); return res({}); }
    assert.strictEqual(o.headers['X-Plex-Token'], 'ST', 'server token on server calls');
    if (url.endsWith('/library/sections')) return res({ MediaContainer: { Directory: [{ key: '1', type: 'movie' }, { key: '2', type: 'show' }] } });
    if (url.includes('/sections/1/all')) return res({ MediaContainer: { totalSize: 2, Metadata: [{ ratingKey: 11, Guid: [{ id: 'tmdb://603' }, { id: 'imdb://tt0133093' }] }, { ratingKey: 12, guid: 'com.plexapp.agents.imdb://tt1375666?lang=en' }] } });
    return res({}, 404); };
  const p = PC.create({ storage: st, fetch });
  await p.refreshLibrary(true);
  assert.ok(p.libraryReady); assert.strictEqual(p.library.count, 2); assert.strictEqual(p.library.servers[0].via, 'remote');
  assert.ok(!tried.some(u => u.startsWith('http://')), 'never tries http (mixed content)');
  assert.strictEqual(p.owned({ tmdb: 603 }).ratingKey, '11'); assert.strictEqual(p.owned({ tmdb: 1, imdb: 'tt1375666' }).ratingKey, '12'); assert.strictEqual(p.owned({ tmdb: 2 }), null);
  assert.ok(p.owned({ tmdb: 603 }).play.startsWith('https://app.plex.tv/desktop/#!/server/mid1/details?key=%2Flibrary%2Fmetadata%2F11'));
  assert.ok(!JSON.stringify(JSON.parse(st.getItem('reelpick.plex.lib'))).includes('ST'), 'server tokens not persisted');
  down = true; await p.refreshLibrary(true);
  assert.ok(p.libraryReady); assert.strictEqual(p.status.lib, 'stale');
});
test('ratingKeyFor falls back: tmdb guid -> imdb guid -> search verified by Guids', async () => {
  const st = mem(); st.setItem('reelpick.plex.auth', JSON.stringify({ token: 'T' })); const calls = [];
  const fetch = async (url, o) => { const u = url.replace('https://discover.provider.plex.tv', ''); calls.push(o.method + ' ' + u);
    if (u.includes('/matches') && u.includes('imdb%3A%2F%2Ftt0113277')) return res({ MediaContainer: { Metadata: [{ ratingKey: 'rk-heat' }] } });
    if (u.includes('/matches')) return res({ MediaContainer: { size: 0 } });
    if (u.startsWith('/library/search')) return res({ MediaContainer: { SearchResults: [{ SearchResult: [
      { Metadata: { ratingKey: 'rk-other', type: 'movie', title: 'Solaris', year: 1972 } },
      { Metadata: { ratingKey: 'rk-sol', type: 'movie', title: 'Solaris', year: 2002 } }] }] } });
    if (u.startsWith('/library/metadata/rk-sol')) return res({ MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://2103' }] }] } });
    if (u.startsWith('/library/metadata/')) return res({ MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://1' }] }] } });
    if (u.includes('/actions/')) return res({});
    return res({}, 404); };
  const p = PC.create({ storage: st, fetch });
  assert.strictEqual(await p.ratingKeyFor({ tmdb: 949, imdb: 'tt0113277', t: 'Heat', y: 1995 }), 'rk-heat');
  assert.strictEqual(await p.ratingKeyFor({ tmdb: 2103, t: 'Solaris', y: 2002 }), 'rk-sol');
  await p.setWatchlist({ tmdb: 2103, t: 'Solaris', y: 2002 }, true); assert.ok(p.onWatchlist(2103));
  assert.ok(calls.includes('PUT /actions/addToWatchlist?ratingKey=rk-sol'));
  await assert.rejects(p.ratingKeyFor({ tmdb: 5, t: 'Nope', y: 1900 }), e => e.status === 404);
  await assert.rejects(PC.create({ storage: mem(), fetch }).setWatchlist(1, true), e => e.status === 401);
});
