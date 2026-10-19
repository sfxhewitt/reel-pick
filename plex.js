/* Reel Pick: Plex integration (browser-only, no backend).
   - Sign in with Plex's PIN flow for web apps (plex.tv/api/v2/pins + app.plex.tv/auth).
   - Plex watchlist via discover.provider.plex.tv (match by tmdb:// guid, add/remove by ratingKey).
   - "On my server": owned servers from clients.plex.tv resources, https (*.plex.direct) connections only
     (local -> remote -> relay), movie sections read with includeGuids=1 into TMDB/IMDb id sets.
   The auth token lives ONLY in this browser's localStorage (key reelpick.plex.auth). It is never logged,
   never put in a URL, and never sent anywhere except Plex's own hosts. Server access tokens stay in memory. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PlexClient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const PLEX_TV = 'https://plex.tv/api/v2', CLIENTS = 'https://clients.plex.tv/api/v2', DISCOVER = 'https://discover.provider.plex.tv';
  const K = { cid: 'reelpick.plex.cid', auth: 'reelpick.plex.auth', pin: 'reelpick.plex.pin', lib: 'reelpick.plex.lib', wl: 'reelpick.plex.wl', match: 'reelpick.plex.match' };
  const LIB_TTL = 6 * 3600e3, WL_TTL = 15 * 60e3;
  const PRODUCT = 'Reel Pick', VERSION = '3.0';

  /* ---------- pure helpers (unit-tested in Node) ---------- */
  function idsFromGuids(item) {
    const out = { tmdb: [], imdb: [] };
    const add = s => { if (!s) return; let m;
      if ((m = /^tmdb:\/\/(\d+)/.exec(s)) || (m = /themoviedb:\/\/(\d+)/.exec(s))) out.tmdb.push(+m[1]);
      else if ((m = /^imdb:\/\/(tt\d+)/.exec(s)) || (m = /agents\.imdb:\/\/(tt\d+)/.exec(s))) out.imdb.push(m[1]); };
    (item.Guid || []).forEach(g => add(g.id)); add(item.guid);
    return out;
  }
  /* https only (an http connection from an https page is blocked as mixed content). Local first, then remote, then relay. */
  function orderConnections(conns) {
    const rank = c => c.relay ? 2 : c.local ? 0 : 1;
    return (conns || []).filter(c => c.protocol === 'https' && /^https:\/\//.test(c.uri || ''))
      .map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(x => x.c);
  }
  const TIMEOUTS = [2500, 6000, 9000];
  function ownedServers(resources) {
    return (resources || []).filter(r => r.owned && String(r.provides || '').split(',').includes('server'));
  }
  function playUrl(machineId, ratingKey) {
    return `https://app.plex.tv/desktop/#!/server/${encodeURIComponent(machineId)}/details?key=${encodeURIComponent('/library/metadata/' + ratingKey)}`;
  }
  function authUrl(cid, code, forwardUrl) {
    const q = new URLSearchParams({ clientID: cid, code, 'context[device][product]': PRODUCT, forwardUrl });
    return 'https://app.plex.tv/auth#?' + q.toString().replace(/\+/g, '%20');
  }

  function create(opts = {}) {
    const ls = opts.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
    const now = opts.now || (() => Date.now());
    const fetchFn = opts.fetch || ((...a) => fetch(...a));
    const get = k => { try { return JSON.parse(ls.getItem(k)); } catch { return null; } };
    const put = (k, v) => { try { v == null ? ls.removeItem(k) : ls.setItem(k, JSON.stringify(v)); } catch {} };
    const listeners = new Set(); const emit = what => listeners.forEach(f => { try { f(what); } catch {} });

    let cid = null; try { cid = ls.getItem(K.cid); } catch {}
    if (!cid) { cid = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : 'rp-' + Math.random().toString(36).slice(2) + now().toString(36); try { ls.setItem(K.cid, cid); } catch {} }

    let auth = get(K.auth);             // { token, user:{ name, thumb } }
    let lib = get(K.lib);               // { t, servers:[{id,name}], tmdb:{id:[s,rk]}, imdb:{tt:[s,rk]}, count, status }
    let wl = get(K.wl);                 // { t, tmdb:{id:rk}, rks:[rk], count }
    let match = get(K.match) || {};     // { tmdbId: rk | 0 (no match) }
    let libBusy = null, wlBusy = null, pollT = null;
    const status = { lib: lib ? (lib.status || 'ok') : 'none', libError: '', wlError: '', wl: wl ? 'ok' : 'none' };
    const servers = new Map();          // machineId -> { uri, token, name } (memory only)

    function headers(token, extra = {}) {
      const h = { Accept: 'application/json', 'X-Plex-Product': PRODUCT, 'X-Plex-Version': VERSION, 'X-Plex-Client-Identifier': cid,
        'X-Plex-Platform': 'Web', 'X-Plex-Device-Name': 'Reel Pick (web)', 'X-Plex-Model': 'hosted' };
      if (token) h['X-Plex-Token'] = token;
      return Object.assign(h, extra);
    }
    async function req(url, { method = 'GET', token = auth && auth.token, timeout = 12000, headers: hx = {} } = {}) {
      const ac = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const t = ac ? setTimeout(() => ac.abort(), timeout) : null;
      try {
        const r = await fetchFn(url, { method, headers: headers(token, hx), signal: ac ? ac.signal : undefined, mode: 'cors', credentials: 'omit' });
        if (r.status === 401 && token && auth && token === auth.token) { signOut('expired'); }
        if (!r.ok) { const e = new Error('Plex HTTP ' + r.status); e.status = r.status;
          try { const b = r.text ? await r.text() : ''; let m = b; try { const j = JSON.parse(b); m = (j.Error && (j.Error.message || j.Error.error)) || (j.errors && j.errors[0] && j.errors[0].message) || b; } catch {} e.reason = String(m || '').replace(/\s+/g, ' ').slice(0, 120); } catch {}
          throw e; }
        const ct = r.headers && r.headers.get ? (r.headers.get('content-type') || '') : '';
        return ct.includes('json') ? r.json() : (r.text ? r.text().then(x => { try { return JSON.parse(x); } catch { return {}; } }) : {});
      } finally { if (t) clearTimeout(t); }
    }

    /* ---------- sign in (PIN flow) ---------- */
    async function newPin() {
      const p = await req(PLEX_TV + '/pins?strong=true', { method: 'POST', token: null });
      const pin = { id: p.id, code: p.code, exp: now() + Math.min(+(p.expiresIn || 1800), 1800) * 1000 };
      put(K.pin, pin); return pin;
    }
    /* Pre-create a pin so the click handler can open the auth page synchronously (popup blockers, iOS standalone). */
    async function preparePin() {
      const p = pendingPin(true); if (p && p.exp - now() > 5 * 60e3) return p;
      return newPin();
    }
    /* started=false: pre-created, not yet opened. Only started pins are polled / shown as "waiting". */
    function pendingPin(any = false) { const p = get(K.pin); if (!p) return null; if (p.exp < now()) { put(K.pin, null); return null; } return (any || p.started) ? p : null; }
    function begin(pin) { pin.started = true; pin.at = now(); put(K.pin, pin); return pin; }
    async function checkPin() {
      const p = pendingPin(); if (!p || auth) return !!auth;
      let r; try { r = await req(`${PLEX_TV}/pins/${encodeURIComponent(p.id)}?code=${encodeURIComponent(p.code)}`, { token: null }); }
      catch (e) { if (e.status === 404) put(K.pin, null); return false; }
      if (r && r.authToken) { await finishSignIn(r.authToken); return true; }
      return false;
    }
    async function finishSignIn(token) {
      put(K.pin, null); stopPolling();
      auth = { token, user: null, t: now() }; put(K.auth, auth);
      try { const u = await req(PLEX_TV + '/user'); auth.user = { name: u.friendlyName || u.username || u.title || 'Plex user', thumb: u.thumb || '' }; put(K.auth, auth); } catch {}
      emit('auth');
      refreshWatchlist(true).catch(() => {}); refreshLibrary(true).catch(() => {});
    }
    function startPolling(intervalMs = 2000) {
      stopPolling();
      const tick = async () => { pollT = null; if (auth || !pendingPin()) { emit('pin'); return; }
        const visible = typeof document === 'undefined' || document.visibilityState !== 'hidden';
        if (visible) await checkPin();
        if (!auth && pendingPin()) pollT = setTimeout(tick, intervalMs); else emit('pin'); };
      pollT = setTimeout(tick, 300);
    }
    function stopPolling() { if (pollT) clearTimeout(pollT); pollT = null; }
    function cancelSignIn() { stopPolling(); put(K.pin, null); emit('pin'); }
    function signOut(why = 'user') {
      stopPolling(); auth = null; lib = null; wl = null; match = {}; servers.clear();
      [K.auth, K.pin, K.lib, K.wl, K.match].forEach(k => put(k, null));
      status.lib = 'none'; status.wl = 'none'; status.libError = '';
      emit(why === 'expired' ? 'expired' : 'auth');
    }

    /* ---------- watchlist ---------- */
    async function pageAll(base, token, size = 200, max = 20000, timeout = 15000) {
      const items = []; let start = 0, total = Infinity;
      while (start < total && start < max) {
        const sep = base.includes('?') ? '&' : '?';
        const j = await req(`${base}${sep}X-Plex-Container-Start=${start}&X-Plex-Container-Size=${size}`, { token, timeout });
        const mc = j.MediaContainer || {}; const got = mc.Metadata || [];
        items.push(...got); total = mc.totalSize != null ? +mc.totalSize : (got.length < size ? start + got.length : Infinity);
        if (!got.length) break; start += got.length;
      }
      return items;
    }
    async function refreshWatchlist(force = false) {
      if (!auth) return null;
      if (!force && wl && now() - wl.t < WL_TTL) return wl;
      if (wlBusy) return wlBusy;
      wlBusy = (async () => {
        try {
          // Same params as watch.plex.tv (size 50); fall back to the bare endpoint if Plex rejects the params.
          let items;
          try { items = await pageAll(`${DISCOVER}/library/sections/watchlist/all?includeCollections=1&includeExternalMedia=1&includeGuids=1`, auth.token, 50); }
          catch (e1) { if (e1.status === 401) throw e1; items = await pageAll(`${DISCOVER}/library/sections/watchlist/all`, auth.token, 50); }
          items = items.filter(it => !it.type || it.type === 'movie');
          const tmdb = {}, rks = [], list = [];
          for (const it of items) { rks.push(String(it.ratingKey));
            list.push({ rk: String(it.ratingKey), t: it.title || '', y: it.year || null, thumb: it.thumb || '', tmdb: idsFromGuids(it).tmdb[0] || null }); for (const id of idsFromGuids(it).tmdb) { tmdb[id] = String(it.ratingKey); match[id] = String(it.ratingKey); } }
          wl = { t: now(), tmdb, rks, items: list, count: items.length }; put(K.wl, wl); put(K.match, match); status.wl = 'ok'; status.wlError = ''; emit('watchlist'); return wl;
        } catch (e) { status.wl = 'error'; status.wlError = (e.status ? 'HTTP ' + e.status : e.name === 'AbortError' ? 'timed out' : 'network error: ' + (e.message || e.name || '?')) + (e.reason ? ': ' + e.reason : ''); emit('watchlist'); throw e; } finally { wlBusy = null; }
      })();
      return wlBusy;
    }
    function onWatchlist(tmdbId) {
      if (!wl || !tmdbId) return false;
      if (wl.tmdb[tmdbId]) return true;
      const rk = match[tmdbId]; return !!(rk && wl.rks.includes(rk));
    }
    /* Resolve a film to a Plex Discover ratingKey. Accepts a TMDB id or a film { tmdb, imdb, t, y }.
       1) cached / watchlist hit, 2) /library/metadata/matches by tmdb:// guid, 3) by imdb:// guid,
       4) /library/search by title, candidates verified via /library/metadata/{rk} Guids (tmdb/imdb), else exact title+year. */
    const norm = s => String(s || '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/&/g, 'and').replace(/[^a-z0-9]+/g, '');
    async function ratingKeyFor(film) {
      const f = typeof film === 'object' && film ? film : { tmdb: film };
      const tmdbId = f.tmdb, key = tmdbId || f.imdb;
      if (key && match[key]) return match[key];
      if (tmdbId && wl && wl.tmdb[tmdbId]) return wl.tmdb[tmdbId];
      const remember = rk => { rk = String(rk); if (key) { match[key] = rk; put(K.match, match); } return rk; };
      const guids = [tmdbId && 'tmdb://' + tmdbId, f.imdb && 'imdb://' + f.imdb].filter(Boolean);
      let lastErr = null;
      for (const g of guids) {
        try {
          const j = await req(`${DISCOVER}/library/metadata/matches?type=1&guid=${encodeURIComponent(g)}`);
          const m = ((j.MediaContainer || {}).Metadata || []).find(x => x && x.ratingKey);
          if (m) return remember(m.ratingKey);
        } catch (e) { if (e.status === 401) throw e; if (e.status !== 404 && e.status !== 400) lastErr = e; }
      }
      if (f.t) {
        try {
          const j = await req(`${DISCOVER}/library/search?query=${encodeURIComponent(f.t)}&searchTypes=movies&searchProviders=discover&includeMetadata=1&includeGuids=1&limit=10`);
          const cands = [];
          for (const r of ((j.MediaContainer || {}).SearchResults || [])) for (const x of (r.SearchResult || [])) { const m = x.Metadata; if (m && m.ratingKey && (!m.type || m.type === 'movie')) cands.push(m); }
          const near = cands.filter(m => !f.y || !m.year || Math.abs(+m.year - +f.y) <= 1).slice(0, 4);
          const hit = ids => (tmdbId && ids.tmdb.includes(+tmdbId)) || (f.imdb && ids.imdb.includes(f.imdb));
          for (const m of near) {
            let ids = idsFromGuids(m);
            if (!ids.tmdb.length && !ids.imdb.length) {
              try { const d = await req(`${DISCOVER}/library/metadata/${encodeURIComponent(m.ratingKey)}?includeGuids=1`); ids = idsFromGuids(((d.MediaContainer || {}).Metadata || [])[0] || {}); }
              catch (e) { if (e.status === 401) throw e; }
            }
            if (hit(ids)) return remember(m.ratingKey);
          }
          const exact = near.filter(m => norm(m.title) === norm(f.t) && (!f.y || +m.year === +f.y));
          if (exact.length === 1) return remember(exact[0].ratingKey);
        } catch (e) { if (e.status === 401) throw e; lastErr = e; }
      }
      if (lastErr) throw lastErr;
      const e = new Error('Not found on Plex'); e.status = 404; throw e;
    }
    async function setWatchlist(film, on) {
      if (!auth) { const e = new Error('Not signed in'); e.status = 401; throw e; }
      const tmdbId = typeof film === 'object' && film ? (film.tmdb || film.imdb) : film;
      const rk = await ratingKeyFor(film);
      await req(`${DISCOVER}/actions/${on ? 'addToWatchlist' : 'removeFromWatchlist'}?ratingKey=${encodeURIComponent(rk)}`, { method: 'PUT' });
      wl = wl || { t: now(), tmdb: {}, rks: [], count: 0 };
      wl.items = wl.items || [];
      if (on) { wl.tmdb[tmdbId] = rk; if (!wl.rks.includes(rk)) { wl.rks.push(rk); wl.items.unshift({ rk, t: film.t || '', y: film.y || null, thumb: film.poster || '', tmdb: film.tmdb || null }); } }
      else { delete wl.tmdb[tmdbId]; wl.rks = wl.rks.filter(x => x !== rk); wl.items = wl.items.filter(x => x.rk !== rk); }
      wl.count = wl.rks.length;
      wl.count = wl.rks.length; put(K.wl, wl); emit('watchlist'); return on;
    }

    /* ---------- library ("on my server") ---------- */
    async function connect(server) {
      const conns = orderConnections(server.connections);
      for (let g = 0; g < 3; g++) {
        const group = conns.filter(c => (c.relay ? 2 : c.local ? 0 : 1) === g); if (!group.length) continue;
        try {
          return await Promise.any(group.map(c => req(c.uri.replace(/\/$/, '') + '/identity', { token: server.accessToken, timeout: TIMEOUTS[g] }).then(() => c)));
        } catch {}
      }
      return null;
    }
    async function refreshLibrary(force = false) {
      if (!auth) return null;
      if (!force && lib && now() - lib.t < LIB_TTL) return lib;
      if (libBusy) return libBusy;
      status.lib = 'loading'; emit('library');
      libBusy = (async () => {
        try {
          const res = await req(`${CLIENTS}/resources?includeHttps=1&includeRelay=1&includeIPv6=0`);
          const owned = ownedServers(Array.isArray(res) ? res : (res.MediaContainer && res.MediaContainer.Device) || []);
          if (!owned.length) { lib = { t: now(), servers: [], tmdb: {}, imdb: {}, count: 0, status: 'noserver' }; put(K.lib, lib); status.lib = 'noserver'; emit('library'); return lib; }
          const out = { t: now(), servers: [], tmdb: {}, imdb: {}, count: 0, status: 'ok', unreachable: [] };
          for (const s of owned) {
            const c = await connect(s);
            if (!c) { out.unreachable.push(s.name); continue; }
            const si = out.servers.length; out.servers.push({ id: s.clientIdentifier, name: s.name, via: c.relay ? 'relay' : c.local ? 'local' : 'remote' });
            servers.set(s.clientIdentifier, { uri: c.uri.replace(/\/$/, ''), token: s.accessToken, name: s.name });
            const base = c.uri.replace(/\/$/, ''), tk = s.accessToken, tmo = c.relay ? 30000 : 20000;
            const secs = (((await req(base + '/library/sections', { token: tk, timeout: tmo })).MediaContainer || {}).Directory || []).filter(d => d.type === 'movie');
            for (const d of secs) {
              const items = await pageAll(`${base}/library/sections/${encodeURIComponent(d.key)}/all?type=1&includeGuids=1`, tk, 1000, 50000, tmo);
              for (const it of items) { const ids = idsFromGuids(it); out.count++;
                ids.tmdb.forEach(id => { if (!out.tmdb[id]) out.tmdb[id] = [si, String(it.ratingKey)]; });
                ids.imdb.forEach(id => { if (!out.imdb[id]) out.imdb[id] = [si, String(it.ratingKey)]; }); }
            }
          }
          if (!out.servers.length) { out.status = 'unreachable'; if (lib && lib.servers && lib.servers.length) { lib.status = 'stale'; lib.unreachable = out.unreachable; status.lib = 'stale'; put(K.lib, lib); emit('library'); return lib; } }
          lib = out; put(K.lib, lib); status.lib = out.status; status.libError = ''; emit('library'); return lib;
        } catch (e) { status.lib = lib && lib.servers && lib.servers.length ? 'stale' : 'error'; status.libError = e.status ? 'HTTP ' + e.status : (e.name === 'AbortError' ? 'timed out' : 'network/CORS error'); emit('library'); throw e; }
        finally { libBusy = null; }
      })();
      return libBusy;
    }
    function owned(f) {
      if (!lib || !f) return null;
      const hit = (f.tmdb && lib.tmdb[f.tmdb]) || (f.imdb && lib.imdb[f.imdb]);
      if (!hit) return null; const s = lib.servers[hit[0]] || {};
      return { server: s.name, machineId: s.id, ratingKey: hit[1], play: playUrl(s.id, hit[1]) };
    }

    /* Another tab/window (e.g. the auth popup landing on forwardUrl) changed storage: pick it up. */
    function reload() {
      const a = get(K.auth), was = !!auth; auth = a; lib = get(K.lib); wl = get(K.wl); match = get(K.match) || {};
      status.lib = lib ? (lib.status || 'ok') : 'none'; status.wl = wl ? 'ok' : 'none';
      if (!!auth !== was) { if (auth) stopPolling(); emit('auth'); } else { emit('library'); emit('watchlist'); }
    }

    return {
      reload,
      get signedIn() { return !!auth; }, get user() { return auth && auth.user; }, get clientId() { return cid; },
      get library() { return lib; }, get libraryReady() { return !!(lib && lib.servers && lib.servers.length); }, get watchlist() { return wl; },
      status, preparePin, pendingPin, begin, checkPin, startPolling, stopPolling, cancelSignIn, signOut, finishSignIn,
      authUrl: (pin, forwardUrl) => authUrl(cid, pin.code, forwardUrl),
      refreshWatchlist, onWatchlist, setWatchlist, ratingKeyFor, refreshLibrary, owned,
      on: f => { listeners.add(f); return () => listeners.delete(f); },
      libStale: () => !lib || now() - lib.t > LIB_TTL, wlStale: () => !wl || now() - wl.t > WL_TTL,
    };
  }
  return { create, idsFromGuids, orderConnections, ownedServers, playUrl, authUrl, KEYS: K, LIB_TTL };
});
