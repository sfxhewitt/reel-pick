/* Reel Pick: movie chooser. Static, no build step.
   Data: data/catalog.json (10k films with build-time affect scores) -> fallback data.js (170 curated films).
   Live TMDB (tmdb.js): backdrops/cast/trailers, runtimes, search + discover beyond the catalogue. No streaming-provider data.
   Recommender: reco.js. Suggestion rules (30-day cooldown, 3 strikes, not interested): rules.js. */
(() => {
'use strict';
const T = window.TMDB, R = window.Reco;
const $ = (s, el = document) => el.querySelector(s), $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtRun = r => r ? `${Math.floor(r/60)}h ${String(r%60).padStart(2,'0')}m` : '';
const hash = s => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
const listJoin = a => a.length <= 1 ? (a[0] || '') : a.slice(0, -1).join(', ') + ' & ' + a[a.length - 1];
const ico = id => `<svg><use href="#i-${id}"/></svg>`;
const IMG = 'https://image.tmdb.org/t/p/';
let toastT; function toast(m, action){ // action: { label, run } adds a tappable button (e.g. Retry) and keeps the toast up longer
  const t = $('#toast'); t.textContent = m; t.classList.toggle('has-act', !!action);
  if (action) { const b = document.createElement('button'); b.className = 'toast-act'; b.type = 'button'; b.textContent = action.label;
    b.onclick = ev => { ev.stopPropagation(); t.classList.remove('show'); action.run(); }; t.appendChild(b); }
  t.classList.add('show'); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), action ? 7000 : 2400); }

const RUNTIMES = { short:{label:'Under 90 min', test:r=>r<90}, mid:{label:'90–120 min', test:r=>r>=90&&r<=120}, long:{label:'2h+', test:r=>r>120} };
const DECADES = { '70s':[1900,1979,'70s & earlier'], '80s':[1980,1989,'80s'], '90s':[1990,1999,'90s'], '00s':[2000,2009,'2000s'], '10s':[2010,2019,'2010s'], '20s':[2020,2099,'2020s'] };
const SLIDERS = [ ['V','Mood','Bleak','Uplifting'], ['A','Intensity','Low-key','Intense'], ['dark','Tone','Light','Dark'], ['humour','Humour','Serious','Funny'],
  ['complex','Complexity','Easy watch','Demanding'], ['pace','Pace','Slow-burn','Fast'], ['weight','Tearjerker','Dry-eyed','Tissues'], ['comfort','Comfort','Challenging','Comforting'] ];
const FLAGS = { noViolence:{label:'No graphic violence', test:f=>f.dims.violence<.5}, noScares:{label:'No scares', test:f=>f.dims.scary<.4},
  family:{label:'Family-friendly', test:f=>f.dims.family>=.6}, noSex:{label:'No explicit sex', test:f=>f.dims.sex<.4}, romance:{label:'Romance', test:f=>f.dims.romance>=.6} };
const MOOD_COL = { grass:'var(--grass)', fire:'var(--fire)', water:'var(--water)', electric:'var(--electric)', psychic:'var(--psychic)', violet:'#7a5cff' };

/* ---------------- persistence ---------------- */
const LS_KEY = 'reelpick.v2';
const store = Object.assign({ fav:[], watch:[], seen:[], tmdbKey:'', snap:{}, fb:[], hero:null, row:null, genrePrefs:{ exclude:[], require:[] } }, (() => {
  try { const v2 = JSON.parse(localStorage.getItem(LS_KEY)); if (v2) return v2; const v1 = JSON.parse(localStorage.getItem('reelpick.v1')) || {};
    return { fav:v1.fav||[], watch:v1.watch||[], seen:v1.seen||[], tmdbKey:v1.tmdbKey||'' }; } catch { return {}; } })());
delete store.services; if (!store.genrePrefs) store.genrePrefs = { exclude:[], require:[] };
const save = () => { try { if (store.fb.length > 400) store.fb = store.fb.slice(-400); localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch {} updateSavedCount(); };
const rules = window.ReelRules.create();
const P = window.PlexClient.create();
if (!['all', 'only', 'hide'].includes(store.plexFilter)) store.plexFilter = 'all';
const has = (list, id) => store[list].includes(id);

/* ---------------- data ---------------- */
let FILMS = [], SOURCE = 'loading', META = null, BAYES = { m: 500, C: 6.8 }, PROFILE = null, LIVE = false, STATS = null;
const BY_ID = new Map();
function finish(f){ Object.assign(f.dims, R.circumplex(f.dims, f.quad)); f.m = R.moodsOf(f); return f; }
function fromCatalog(j){
  const G = j.genres, K = j.keywords, D = j.meta.dims;
  return j.films.map(r => {
    const [id, t, y, run, rating, votes, gids, kix, poster, dims, quad, svc, cert, imdb, jev] = r;
    const d = {}; D.forEach((k, i) => d[k] = dims[i] / 100);
    const q = { excited:quad[0]/100, content:quad[1]/100, tense:quad[2]/100, sad:quad[3]/100 };
    return finish({ id:'tmdb-'+id, tmdb:id, src:'cat', t, y, r:run, i:rating, votes, g:gids.map(x=>G[x]).filter(Boolean), kw:kix.map(x=>K[x]),
      poster: poster ? IMG+'w342'+poster : '', d:'', dims:d, quad:q, cert, imdb, jev:!!jev });
  });
}
function fromLocal(){
  const slug = s => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g,'-').replace(/^-|-$/g,'');
  return (window.MOVIES_RAW||[]).map(([t,y,r,i,g,m,s,d]) => { const gs = g.split(' '); const h = R.heuristicDims(gs);
    return finish({ id:slug(t+'-'+y), src:'local', t, y, r, i, votes:20000, g:gs, kw:[], poster:'', d, dims:h.dims, quad:h.quad }); });
}
function liveFilm(m){ // TMDB live result -> recommender-ready film (heuristic affect from genres)
  const ex = BY_ID.get(m.id); if (ex) { if (!ex.poster) ex.poster = m.poster; return ex; }
  const h = R.heuristicDims(m.g); const f = finish(Object.assign(m, { src:'live', kw:[], dims:h.dims, quad:h.quad }));
  f.tf = TFIDF ? TFIDF.vec(f) : null; BY_ID.set(f.id, f); return f;
}
let TFIDF = null;
async function loadData(){
  try {
    const r = await fetch('data/catalog.json'); if (!r.ok) throw new Error(r.status);
    const j = await r.json(); META = j.meta; FILMS = fromCatalog(j); SOURCE = 'catalog';
  } catch (e) { FILMS = fromLocal(); SOURCE = 'local'; }
  FILMS.forEach(f => BY_ID.set(f.id, f));
  TFIDF = R.buildTfidf(FILMS); BAYES = R.bayesStats(FILMS); FILMS.forEach(f => f.wr = R.bayes(f, BAYES));
  for (const [id, s] of Object.entries(store.snap)) if (!BY_ID.has(id)) liveFilm(Object.assign({}, s));
  recomputeProfile();
}
function loadOverviews(){
  if (SOURCE !== 'catalog') return;
  fetch('data/overviews.json').then(r => r.ok ? r.json() : {}).then(o => { for (const f of FILMS) if (!f.d) f.d = o[f.tmdb] || ''; refreshAll(true); }).catch(() => {});
}
const getM = id => BY_ID.get(id);
function snap(f){ if (f.src === 'cat' || f.src === 'local') return; store.snap[f.id] = { id:f.id, tmdb:f.tmdb, t:f.t, y:f.y, r:f.r, i:f.i, votes:f.votes, g:f.g, d:f.d, poster:f.poster }; }
function recomputeProfile(){
  const ev = [...store.fb, ...store.fav.map(id=>({id,type:'fav'})), ...store.watch.map(id=>({id,type:'watch'}))];
  PROFILE = R.rocchio(ev, getM);
}

/* ---------------- lists & feedback ---------------- */
function toggleList(list, id){
  const i = store[list].indexOf(id); const f = getM(id);
  if (i >= 0) store[list].splice(i, 1); else { store[list].push(id); if (f) snap(f); }
  if (list === 'seen' && i < 0) { const w = store.watch.indexOf(id); if (w >= 0) store.watch.splice(w, 1); }
  save(); recomputeProfile();
  const msgs = { fav:['Added to favourites','Removed from favourites'], watch:['Added to watchlist','Removed from watchlist'], seen:['Marked as seen','Unmarked as seen'] };
  toast(`${i < 0 ? msgs[list][0] : msgs[list][1]}: ${f ? f.t : ''}`); refreshAll();
  if (list === 'watch') plexSync(id, i < 0);
}
/* One-way add (never toggles off): used by result cards that dismiss the film. No re-render here; the caller does it after the exit animation. */
function addToList(list, id){
  const f = getM(id), already = has(list, id);
  if (!already) { store[list].push(id); if (f) snap(f); }
  if (list === 'seen') { const w = store.watch.indexOf(id); if (w >= 0) store.watch.splice(w, 1); }
  save(); recomputeProfile();
  const t = f ? f.t : '';
  toast(list === 'watch' ? (already ? `Already on your watchlist: ${t}` : `Added to watchlist: ${t}`) : `Marked as seen: ${t}`);
  if (list === 'watch') plexSync(id, true);
}
function feedback(type, id){
  const f = getM(id); if (!f) return;
  store.fb = store.fb.filter(e => !(e.id === id && (e.type === 'like' || e.type === 'dislike')));
  if (type === 'like' || type === 'dislike') store.fb.push({ id, type, ts: Date.now() });
  if (type === 'notint') { rules.notInterested(id); store.fb.push({ id, type:'notint', ts: Date.now() }); }
  if (type === 'skip') { const s = rules.skip(id); store.fb.push({ id, type:'skip', ts: Date.now() }); if (s.banned) toast(`3 skips: ${f.t} is hidden for a year`); }
  snap(f); save(); recomputeProfile();
  if (type === 'like') toast(`Liked ${f.t}: more like this`);
  if (type === 'dislike') toast(`Got it: less like ${f.t}`);
  if (type === 'notint') toast(`Not interested: ${f.t} is hidden for a year`);
}
const fbOf = id => { const e = [...store.fb].reverse().find(e => e.id === id && (e.type === 'like' || e.type === 'dislike')); return e ? e.type : null; };

/* ---------------- recommendation context & candidate pools ---------------- */
/* Saved genre preferences: exclusions (and optional requirements) are HARD filters everywhere. */
function genreOK(f){
  const gp = store.genrePrefs; if (!gp) return true;
  if (gp.exclude.length && f.g.some(g => gp.exclude.includes(g))) return false;
  if (gp.require.length && !f.g.some(g => gp.require.includes(g))) return false;
  return true;
}
/* Plex "on my server" filter (all / only / hide); ignored until the library has been read. */
function plexOK(f){
  if (store.plexFilter === 'all' || !P.libraryReady) return true;
  const own = !!P.owned(f); return store.plexFilter === 'only' ? own : !own;
}
const prefOK = f => genreOK(f) && plexOK(f);
const gpKey = () => store.genrePrefs.exclude.join(',') + '|' + store.genrePrefs.require.join(',') + '|plex:' + (P.libraryReady ? store.plexFilter : 'all');
function allGenres(){ return [...new Set(FILMS.flatMap(f => f.g))].sort(); }
/* state: 0 neutral, 1 exclude, 2 require */
function genreState(g){ const gp = store.genrePrefs; return gp.exclude.includes(g) ? 1 : gp.require.includes(g) ? 2 : 0; }
function setGenre(g, st){
  const gp = store.genrePrefs; gp.exclude = gp.exclude.filter(x => x !== g); gp.require = gp.require.filter(x => x !== g);
  if (st === 1) gp.exclude.push(g); if (st === 2) gp.require.push(g);
  store.hero = null; store.row = null; save();
}
/* Tri-state genre chips: tap = exclude (the prominent action), tap again or long-press = require, third tap = clear. */
function genreControl(el, onChange){
  const draw = () => {
    const gp = store.genrePrefs;
    el.innerHTML = `<div class="gsum muted">${gp.exclude.length ? `Never: <b class="gx">${esc(gp.exclude.join(', '))}</b>` : 'Nothing ruled out yet.'}${gp.require.length ? ` · Must be: <b class="gr">${esc(gp.require.join(' or '))}</b>` : ''}</div>
      <div class="chips wrap gchips">${allGenres().map(g => { const st = genreState(g); return `<button class="chip gchip" data-g="${esc(g)}" data-st="${st}" aria-pressed="${st > 0}" aria-label="${esc(g)}: ${['neutral', 'excluded', 'required'][st]}">${st === 1 ? '✕ ' : st === 2 ? '+ ' : ''}${esc(g)}</button>`; }).join('')}</div>
      ${gp.exclude.length || gp.require.length ? '<button class="link" data-gclear>Clear genre preferences</button>' : ''}`;
    $$('.gchip', el).forEach(b => {
      let timer = null, long = false;
      const g = b.dataset.g;
      b.addEventListener('pointerdown', () => { long = false; timer = setTimeout(() => { long = true; setGenre(g, 2); draw(); onChange(); }, 500); });
      ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => b.addEventListener(ev, () => clearTimeout(timer)));
      b.addEventListener('contextmenu', e => e.preventDefault());
      b.addEventListener('click', () => { if (long) { long = false; return; } setGenre(g, (genreState(g) + 1) % 3); draw(); onChange(); });
    });
    const c = $('[data-gclear]', el); if (c) c.onclick = () => { store.genrePrefs = { exclude: [], require: [] }; store.hero = null; store.row = null; save(); draw(); onChange(); };
  };
  draw();
}
function baseCtx(extra = {}){ return Object.assign({ bayes:BAYES, profile:PROFILE }, extra); }
function candidates({ runtime = null, avoid = null, minVotes = 0, filter = null, allowCooldown = false } = {}){
  return FILMS.filter(f => !has('seen', f.id) && (allowCooldown ? !rules.banInfo(f.id) && !rules.session.has(f.id) : rules.eligible(f.id))
    && prefOK(f)
    && (!runtime || [...runtime].some(k => RUNTIMES[k].test(f.r)))
    && (!avoid || avoid(f) === false) && (f.votes || 0) >= minVotes && (!filter || filter(f)));
}
function suggest(cands, ctx, k, lambda){ return R.mmr(R.rank(cands, ctx), k, lambda); }

/* ---------------- poster / badges / cards ---------------- */
function posterHTML(f){
  const h = hash(f.t), h1 = h % 360, h2 = (h1 + 60 + (h >> 8) % 90) % 360;
  const img = f.poster ? `<img src="${esc(f.poster)}" alt="${esc(f.t)} poster" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="poster" data-poster="${esc(f.id)}" style="--p1:hsl(${h1} 90% 55%);--p2:hsl(${h2} 90% 50%)"><div class="art"><div class="ptitle">${esc(f.t)}</div><div class="pyear">${f.y||''}</div></div>${img}</div>`;
}
function moodBadges(f){ return (f.m || []).slice(0, 2).map(k => `<span class="badge mtag" style="--mc:${MOOD_COL[R.MOODS[k].c]}">${R.MOODS[k].label}</span>`).join(''); }
const HEART = '<svg viewBox="0 0 24 24"><path d="M12 20s-7-4.4-9.2-9C1.4 7.9 3.4 4.5 6.8 4.5c2 0 3.4 1.1 4.2 2.4h2c.8-1.3 2.2-2.4 4.2-2.4 3.4 0 5.4 3.4 4 6.5C19 15.6 12 20 12 20z"/></svg>';
const PIN = '<svg viewBox="0 0 24 24"><path d="M6 3h12v18l-6-4-6 4z"/></svg>';
const PLEXI = '<svg viewBox="0 0 24 24"><path d="M8 3h5l6 9-6 9H8l6-9z"/></svg>';
function plexBadge(f, big = false){ const o = P.owned(f); return o ? `<span class="badge onplex${big ? '' : ' sm'}" title="On ${esc(o.server || 'your Plex server')}">On Plex</span>` : ''; }
function plexWlBtn(f, cls = 'starbtn'){
  if (!P.signedIn || !f.tmdb) return '';
  const on = P.onWatchlist(f.tmdb);
  return cls === 'starbtn'
    ? `<button class="starbtn plexwl ${on ? 'on' : ''}" data-act="plexwl" aria-pressed="${on}" aria-label="${on ? 'Remove from Plex watchlist' : 'Add to Plex watchlist'}" title="${on ? 'On your Plex watchlist' : 'Add to Plex watchlist'}">${PLEXI}</button>`
    : `<button class="btn plexwl ${on ? 'on' : ''}" data-act="plexwl" aria-pressed="${on}">${PLEXI}<span>${on ? 'On Plex watchlist' : 'Add to Plex watchlist'}</span></button>`;
}
function cardHTML(f, rr, { mini = false, ctx = null, match = false, maxScore = 1 } = {}){
  const pct = match && rr ? Math.max(40, Math.min(99, Math.round(55 + 44 * rr.score / Math.max(maxScore, .01)))) : 0;
  const col = f.m && f.m[0] ? MOOD_COL[R.MOODS[f.m[0]].c] : 'var(--water)';
  return `<article class="card deal ${mini ? 'mini' : ''}" data-id="${esc(f.id)}" style="--c:${col}">
    ${pct ? `<span class="matchpill">${pct}% match</span>` : ''}
    <div class="tools"><button class="starbtn ${has('fav', f.id) ? 'on fav' : ''}" data-act="fav" aria-label="Favourite" title="Favourite">${HEART}</button><button class="starbtn ${has('watch', f.id) ? 'on' : ''}" data-act="watch" aria-label="Watchlist" title="Watchlist">${PIN}</button>${plexWlBtn(f)}</div>
    <div data-open>${posterHTML(f)}</div>
    <div class="body"><h4 class="t" data-open>${esc(f.t)}</h4>
      <div class="meta"><span class="star" title="Bayesian weighted rating (TMDB ${f.i.toFixed(1)} from ${R.fmtVotes(f.votes)} votes)">★ ${(f.wr ?? f.i).toFixed(1)}</span><span>${f.y || ''}</span><span data-run="${esc(f.id)}">${fmtRun(f.r)}</span>${f.src === 'live' ? '<span class="badge live">TMDB</span>' : ''}${plexBadge(f)}</div>
      ${mini ? '' : `<div class="tags">${moodBadges(f)}${f.g.slice(0, 2).map(g => `<span class="badge">${esc(g)}</span>`).join('')}</div>
      ${f.d ? `<p class="syn">${esc(f.d)}</p>` : ''}
      ${rr && ctx ? `<div class="reason">${esc(R.why(rr, ctx))}</div>` : ''}`}
    </div></article>`;
}
function updateBits(f){
  $$(`[data-run="${CSS.escape(f.id)}"]`).forEach(el => el.textContent = fmtRun(f.r));
  if (f.poster) $$(`[data-poster="${CSS.escape(f.id)}"]`).forEach(el => { if (!el.querySelector('img')) el.insertAdjacentHTML('beforeend', `<img src="${esc(f.poster)}" alt="" loading="lazy" onerror="this.remove()">`); });
}
function afterRender(root){ // live-search/discover results lack runtime: fetch it (no provider data is requested)
  if (!LIVE) return;
  $$('[data-run]', root).forEach(el => { const f = getM(el.dataset.run); if (f && f.src === 'live' && !f.r && !f._rq) { f._rq = 1; T.enqueue(f, m => { if (store.snap[m.id]) snap(m); updateBits(m); }); } });
}

/* ---------------- global clicks ---------------- */
document.addEventListener('click', e => {
  const act = e.target.closest('[data-act]');
  if (act) { const card = act.closest('[data-id]'); if (card) { e.stopPropagation(); const a = act.dataset.act, id = card.dataset.id;
    const dc = act.closest('[data-dismiss]');
    if (dc && ['watch','seen','notint'].includes(a)) dismissPick(a, id, dc);
    else if (['fav','watch','seen'].includes(a)) toggleList(a, id);
    else if (a === 'like' || a === 'dislike') { feedback(fbOf(id) === a ? 'clear' : a, id); refreshAll(); }
    else if (a === 'notint') { feedback('notint', id); if (picker && picker.cur && picker.cur.f.id === id) nextPick(false); else { closeModal(); refreshAll(); } }
    else if (a === 'unban') { rules.unban(id); toast('Unhidden'); renderSaved(); }
    else if (a === 'plexwl') togglePlexWL(id, act);
    return; } }
  const open = e.target.closest('[data-open]');
  if (open) { const card = open.closest('[data-id]'); if (card) openDetail(card.dataset.id); }
  if (e.target.closest('[data-close]')) closeModal();
  const go = e.target.closest('[data-goto]'); if (go) switchView(go.dataset.goto);
  if (e.target.closest('[data-plexsettings]')) { closeModal(); setTimeout(() => $('#settingsBtn').click(), 0); }
  const pf = e.target.closest('[data-pf]'); if (pf) setPlexFilter(pf.dataset.pf);
});
document.addEventListener('keydown', e => { if (e.key === 'Escape') { closeModal(); $('#filters').classList.remove('open'); } });

/* ---------------- modal / detail ---------------- */
let lastFocus = null, modalState = null, picker = null;
/* Sheets: one visible Close control in a sticky bar below the safe area; Esc, browser/OS back and swipe-down also close. */
let ignorePop = false, pendingPush = false;
/* One history entry per open sheet so iOS/Android back closes it. If a close's history.back() is still in flight, defer the push. */
function pushSheet(){ if (ignorePop) { pendingPush = true; return; } try { history.pushState({ rpModal: 1 }, '', '#' + curView); } catch {} }
function openModal(html, detail = false, title = ''){
  const was = $('#modal').hidden; if (was) lastFocus = document.activeElement;
  $('#sheetTitle').textContent = title || (detail ? 'Film' : '');
  $('#modalBody').innerHTML = html; $('.modal-card').classList.toggle('is-detail', !!detail); $('#modal').hidden = false; document.body.classList.add('sheet-open');
  if (was) { $('.modal-card').scrollTop = 0; pushSheet(); }
  afterRender($('#modalBody')); if (was) requestAnimationFrame(() => $('#sheetClose').focus({ preventScroll: true }));
}
function closeModal(viaHistory = false){
  if ($('#modal').hidden) return; $('#modal').hidden = true; document.body.classList.remove('sheet-open'); $('.modal-card').style.transform = '';
  picker = null; modalState = null;
  if (!viaHistory && history.state && history.state.rpModal) { ignorePop = true; history.back(); }
  if (lastFocus && lastFocus.focus) lastFocus.focus({ preventScroll: true }); lastFocus = null;
}
window.addEventListener('popstate', () => {
  if (ignorePop) { ignorePop = false; history.replaceState(null, '', '#' + curView); if (pendingPush) { pendingPush = false; if (!$('#modal').hidden) pushSheet(); } return; }
  if (!$('#modal').hidden) closeModal(true);
});
(() => { // swipe down to close (from the sheet bar anywhere, or from the content when scrolled to the top)
  const card = $('.modal-card'); let y0 = null, dy = 0;
  card.addEventListener('touchstart', e => { if (card.scrollTop > 0 && !e.target.closest('.sheet-bar')) { y0 = null; return; } y0 = e.touches[0].clientY; dy = 0; }, { passive: true });
  card.addEventListener('touchmove', e => { if (y0 == null) return; dy = e.touches[0].clientY - y0; if (dy > 0) card.style.transform = `translateY(${Math.min(dy, 300) * .6}px)`; }, { passive: true });
  card.addEventListener('touchend', () => { if (y0 == null) return; if (dy > 90) closeModal(); else card.style.transform = ''; y0 = null; });
})();
document.addEventListener('keydown', e => {
  if (e.key !== 'Tab' || $('#modal').hidden) return;
  const f = $$('.modal-card button, .modal-card a[href], .modal-card input').filter(x => x.offsetParent); if (!f.length) return;
  if (e.shiftKey && document.activeElement === f[0]) { e.preventDefault(); f[f.length-1].focus(); } else if (!e.shiftKey && document.activeElement === f[f.length-1]) { e.preventDefault(); f[0].focus(); }
});
const DIM_BARS = [['V','Valence','bleak','uplifting'],['A','Intensity','calm','intense'],['dark','Darkness'],['humour','Humour'],['complex','Complexity'],['pace','Pace'],['weight','Tearjerker'],['comfort','Comfort']];
function detailHTML(f, rr, { title = '', again = false, ctx = null } = {}){
  const x = f.extra || {}; const q = encodeURIComponent(f.t + ' ' + (f.y || ''));
  const onW = has('watch', f.id), onF = has('fav', f.id), onS = has('seen', f.id), fb = fbOf(f.id), own = P.owned(f);
  const trailer = x.trailer || `https://www.youtube.com/results?search_query=${q}+trailer`;
  rr = rr || R.relevance(f, ctx || baseCtx());
  const cast = x.cast && x.cast.length ? `<section class="dv-sec"><h4>Cast</h4><ul class="dv-cast">${x.cast.map(c => `<li><span class="dv-av">${c.p ? `<img src="${esc(c.p)}" alt="" loading="lazy" onerror="this.remove()">` : ''}<i>${esc(c.n.split(/\s+/).map(w=>w[0]).slice(0,2).join(''))}</i></span><b>${esc(c.n)}</b><small>${esc(c.c || '')}</small></li>`).join('')}</ul></section>` : '';
  const bars = DIM_BARS.map(([k, l]) => { const v = f.dims[k] ?? .5; return `<div class="bar"><span>${l}</span><i style="--v:${Math.round(v*100)}%"></i><b>${Math.round(v*100)}</b></div>`; }).join('');
  const flags = Object.entries(FLAGS).filter(([k]) => k !== 'romance').map(([k, v]) => v.test(f) ? `<span class="badge ok">${v.label}</span>` : '').join('') + (f.dims.violence >= .5 ? '<span class="badge bad">Violence</span>' : '') + (f.dims.scary >= .4 ? '<span class="badge bad">Scary</span>' : '');
  return `<article class="dv" data-id="${esc(f.id)}">
    <div class="dv-hero"><div class="dv-backdrop">${f.backdrop ? `<img src="${esc(f.backdrop)}" alt="" onerror="this.remove()">` : ''}</div><div class="dv-shade"></div>
      <div class="dv-head"><div class="dv-poster">${posterHTML(f)}</div><div class="dv-titles">
        ${title ? `<div class="dv-eyebrow">${esc(title)}</div>` : ''}<h2 id="dvTitle">${esc(f.t)}</h2>${x.tagline ? `<p class="dv-tagline">${esc(x.tagline)}</p>` : ''}
        <div class="meta dv-meta"><span class="badge ok" title="Bayesian weighted rating">★ ${(f.wr ?? f.i).toFixed(1)} weighted</span><span class="badge">TMDB ${f.i.toFixed(1)} · ${R.fmtVotes(f.votes)} votes</span>${f.y ? `<span class="badge">${f.y}</span>` : ''}${f.r ? `<span class="badge" data-run="${esc(f.id)}">${fmtRun(f.r)}</span>` : ''}${f.cert ? `<span class="badge">${esc(f.cert)}</span>` : ''}${f.g.map(g => `<span class="badge">${esc(g)}</span>`).join('')}${plexBadge(f, true)}</div>
        <div class="dv-actions">
          <a class="buy" target="_blank" rel="noopener" href="${esc(trailer)}">Trailer ${ico('ext')}</a>
          ${again ? `<button class="btn primary" id="againBtn">${ico('dice')} Pick another</button>` : ''}
          <button class="btn ${onW ? 'on' : ''}" data-act="watch" aria-pressed="${onW}">${onW ? 'On watchlist' : 'Watchlist'}</button>
          ${plexWlBtn(f, 'btn')}${own ? `<a class="btn plexplay" target="_blank" rel="noopener" href="${esc(own.play)}">${PLEXI}<span>Play on Plex</span></a>` : ''}
          <div class="dv-fb">
            <button class="iconbtn ${fb === 'like' ? 'on' : ''}" data-act="like" aria-pressed="${fb === 'like'}" aria-label="Like" title="Like: more like this">▲</button>
            <button class="iconbtn ${fb === 'dislike' ? 'on bad' : ''}" data-act="dislike" aria-pressed="${fb === 'dislike'}" aria-label="Dislike" title="Dislike: less like this">▼</button>
            <button class="iconbtn ${onF ? 'on fav' : ''}" data-act="fav" aria-pressed="${onF}" aria-label="Favourite" title="Favourite">${HEART}</button>
            <button class="iconbtn ${onS ? 'on' : ''}" data-act="seen" aria-pressed="${onS}" aria-label="${onS ? 'Unmark seen' : 'Mark seen'}" title="Seen it">✓</button>
            <button class="iconbtn" data-act="notint" aria-label="Not interested" title="Not interested: hide for a year">⊘</button>
          </div>
        </div></div></div></div>
    <div class="dv-body"><div class="dv-main">
        <div class="dv-why"><span class="h2">Why this pick</span><p>${esc(R.why(rr, ctx || baseCtx()))}</p></div>
        ${f.d ? `<p class="dv-syn">${esc(f.d)}</p>` : ''}
        ${x.director && x.director.length ? `<div class="dv-credit"><span>Directed by</span> <b>${esc(listJoin(x.director))}</b></div>` : ''}
        <section class="dv-sec"><h4>Mood profile <small>${f.jev ? 'TypeSafe Jev' : f.src === 'cat' ? 'estimated from genres & keywords' : 'estimated from genres'}</small></h4><div class="bars">${bars}</div><div class="tags">${moodBadges(f)}${flags}</div></section>
        ${cast}
      </div>
      <aside class="dv-side"><section class="dv-sec panel dv-more"><h4>More</h4>
          <a class="dv-link" target="_blank" rel="noopener" href="${f.imdb ? 'https://www.imdb.com/title/' + esc(f.imdb) + '/' : 'https://www.imdb.com/find/?q=' + q}">IMDb ${ico('ext')}</a>
          <a class="dv-link" target="_blank" rel="noopener" href="${f.tmdb ? 'https://www.themoviedb.org/movie/' + f.tmdb : 'https://www.themoviedb.org/search?query=' + q}">TMDB ${ico('ext')}</a>
          <a class="dv-link" target="_blank" rel="noopener" href="https://letterboxd.com/search/${encodeURIComponent(f.t)}/">Letterboxd ${ico('ext')}</a>
          ${P.signedIn ? '' : '<button class="dv-link plexconnect" data-plexsettings>Connect Plex: watchlist & “on my server” →</button>'}</section>
      </aside></div></article>`;
}
function showDetail(f, rr = null, title = '', again = null, ctx = null, keepScroll = false){
  modalState = { f, rr, title, again, ctx };
  const st = keepScroll ? $('.modal-card').scrollTop : 0;
  openModal(detailHTML(f, rr, { title, again: !!again, ctx }), true, f.t);
  if (keepScroll) $('.modal-card').scrollTop = st;
  if (again) $('#againBtn').onclick = again;
  if (LIVE && !f.extra && !f._full) { f._full = true; T.details(f, true).then(() => { if (store.snap[f.id]) snap(f); updateBits(f); if (modalState && modalState.f === f && !$('#modal').hidden) showDetail(f, modalState.rr, modalState.title, modalState.again, modalState.ctx, true); }).catch(() => { f._full = false; }); }
}
function openDetail(id){ const f = getM(id); if (f) showDetail(f); }

/* ---------------- picker (surprise flow, honours rules) ---------------- */
function openPicker(list, label, ctx){
  const queue = list.filter(r => rules.eligible(r.f.id));
  if (!queue.length) { toast('Nothing new matches. Loosen a filter, or clear cooldowns in Settings'); return; }
  picker = { queue, label, ctx, total: list.length, cur: null };
  nextPick(false, true);
}
function nextPick(skipCurrent = true, first = false){
  if (!picker) return;
  if (skipCurrent && picker.cur) feedback('skip', picker.cur.f.id);
  while (picker.queue.length && !rules.eligible(picker.queue[0].f.id)) picker.queue.shift();
  const r = picker.queue.shift();
  if (!r) { const p = picker; closeModal(); toast(`That's all ${p.total} matches for now`); refreshAll(); return; }
  picker.cur = r; rules.markShown(r.f.id);
  const p = picker;
  showDetail(r.f, r, `${p.label} · ${p.queue.length} more lined up`, () => nextPick(true), p.ctx);
  picker = p; // showDetail->openModal keeps picker; closeModal clears it
  if (!first) $('#modalBody .dv').classList.add('rerolled');
}

/* ---------------- TONIGHT ---------------- */
const today = () => new Date().toLocaleDateString('en-CA');
function tonightCtx(){
  const dow = new Date().getDay(), wk = dow >= 1 && dow <= 4, hr = new Date().getHours();
  const target = hr >= 22 || hr < 5 ? { comfort: .7, complex: .35 } : wk ? { complex: .45 } : null;
  return { ctx: baseCtx({ target, prefer: 'classic' }), runtime: wk ? new Set(['short', 'mid']) : null, wk };
}
function renderHero(reroll = false){
  if (!FILMS.length) return;
  const { ctx, runtime, wk } = tonightCtx(); let rr = null;
  if (reroll && store.hero) { feedback('skip', store.hero.id); store.hero = null; }
  if (store.hero && store.hero.date === today()) { const f = getM(store.hero.id); if (f && !has('seen', f.id) && !rules.banInfo(f.id) && prefOK(f)) rr = R.relevance(f, ctx); }
  if (!rr) {
    let c = candidates({ runtime, minVotes: 1500 }); if (c.length < 5) c = candidates({ runtime });
    const top = suggest(c, ctx, 8, .7); if (!top.length) { $('#hero').innerHTML = '<div class="empty">Everything is on cooldown. Clear cooldowns in Settings.</div>'; return; }
    const rnd = hash(today() + (reroll ? Math.random() : '')) % Math.min(4, top.length); rr = top[rnd];
    rules.markShown(rr.f.id); store.hero = { date: today(), id: rr.f.id }; save();
  }
  const f = rr.f, day = new Date().toLocaleDateString('en-GB', { weekday: 'long' });
  const dayWhy = wk ? `It's a ${day}, so we kept it under two hours.` : `It's ${day}: proper film-night territory.`;
  $('#hero').innerHTML = `<div class="hero-bg" style="${f.poster ? `background-image:url('${esc(f.poster)}')` : ''}"></div>
    <div data-id="${esc(f.id)}" class="hero-poster"><div data-open>${posterHTML(f)}</div></div>
    <div data-id="${esc(f.id)}" class="hero-body"><span class="eyebrow">Tonight's pick · ${day}</span><h2 class="hero-t">${esc(f.t)}</h2>
      <div class="meta"><span class="star">★ ${f.wr.toFixed(1)}</span><span>${f.y || ''}</span><span data-run="${esc(f.id)}">${fmtRun(f.r)}</span><span>${esc(f.g.slice(0,3).join(' · '))}</span></div>
      ${f.d ? `<p class="syn">${esc(f.d)}</p>` : ''}
      <div class="why"><b>Why this one?</b> ${esc(dayWhy)} ${esc(R.why(rr, ctx))}</div>
      <div class="actions"><button class="buy" data-open>Details</button><button class="btn ${has('watch', f.id) ? 'on' : ''}" data-act="watch">${has('watch', f.id) ? 'On watchlist' : 'Watchlist'}</button>
        <button class="btn" id="rerollHero" title="Counts as a skip">Not feeling it</button><button class="btn" data-goto="quiz">Take the quiz</button></div></div>`;
  $('#rerollHero').onclick = () => renderHero(true);
  afterRender($('#hero'));
}
function renderQuickMoods(){
  $('#quickMoods').innerHTML = Object.entries(R.MOODS).map(([k, v]) => `<button class="mood" data-mood="${k}" style="--mc:${MOOD_COL[v.c]}"><span class="l">${v.label}</span><span class="s">${v.s}</span></button>`).join('')
    + `<button class="mood" data-mood="*" style="--mc:var(--txt)"><span class="l">Anything</span><span class="s">Total wildcard</span></button>`;
  $$('#quickMoods .mood').forEach(b => b.onclick = () => {
    const k = b.dataset.mood;
    const ctx = baseCtx(k === '*' ? {} : { target: R.moodTarget(k), moodLabel: R.MOODS[k].label });
    const c = candidates({ filter: k === '*' ? null : f => R.fitsMood(f, k) });
    const ranked = R.rank(c, ctx); const pool = ranked.slice(0, 60); // shuffle the top a little so every tap feels fresh
    const sh = pool.map(r => [r, r.score + Math.random() * .08]).sort((a, b) => b[1] - a[1]).map(x => x[0]);
    openPicker(R.mmr(sh, 20, .7, 60), k === '*' ? 'Wildcard' : R.MOODS[k].label, ctx);
  });
}
function renderTonightRow(){
  if (!FILMS.length) return;
  const ctx = baseCtx({ prefer: 'classic' }); let list = null;
  if (store.row && store.row.date === today() && store.row.gp === gpKey()) list = store.row.ids.map(getM).filter(f => f && !has('seen', f.id) && !rules.banInfo(f.id) && prefOK(f)).map(f => R.relevance(f, ctx));
  if (!list || list.length < 6) {
    list = suggest(candidates({ minVotes: 3000 }), ctx, 14, .65);
    rules.markShown(list.map(r => r.f.id)); store.row = { date: today(), gp: gpKey(), ids: list.map(r => r.f.id) }; save();
  }
  $('#tonightRow').innerHTML = list.map(r => cardHTML(r.f, r, { mini: true })).join('') || '<p class="muted">Nothing here yet.</p>';
  afterRender($('#tonightRow'));
}

/* ---------------- BROWSE ---------------- */
const F = { moods:new Set(), genres:new Set(), runtime:new Set(), decades:new Set(), flags:new Set(), dims:{}, yFrom:null, yTo:null, minRating:0,
  hideSeen:true, q:'', sort:'match', src:'cat' };
const B = { page: 1, list: [], live: { items: [], page: 0, pages: 0, total: 0 }, token: 0, onlyLiveFilter: false };
const PAGE = 48;
function chipSet(el, entries, set, onChange){
  el.innerHTML = entries.map(([k, label]) => `<button class="chip" data-k="${esc(k)}" aria-pressed="${set.has(k)}">${label}</button>`).join('');
  $$('.chip', el).forEach(b => b.onclick = () => { const k = b.dataset.k; set.has(k) ? set.delete(k) : set.add(k); b.setAttribute('aria-pressed', set.has(k)); onChange(); });
}
function buildFilters(){
  chipSet($('#fMood'), Object.entries(R.MOODS).map(([k, v]) => [k, v.label]), F.moods, renderBrowse);
  const genres = [...new Set(FILMS.flatMap(f => f.g))].sort();
  chipSet($('#fGenre'), genres.map(g => [g, g]), F.genres, renderBrowse);
  chipSet($('#fRuntime'), Object.entries(RUNTIMES).map(([k, v]) => [k, v.label]), F.runtime, renderBrowse);
  chipSet($('#fDecade'), Object.entries(DECADES).map(([k, v]) => [k, v[2]]), F.decades, renderBrowse);
  chipSet($('#fFlags'), Object.entries(FLAGS).map(([k, v]) => [k, v.label]), F.flags, renderBrowse);
  genreControl($('#fGenrePrefs'), () => { renderBrowse(); });
  $('#fDims').innerHTML = SLIDERS.map(([k, l, lo, hi]) => `<div class="dim" data-k="${k}"><div class="dimh"><span>${l}</span><output>${F.dims[k] != null ? Math.round(F.dims[k]*100) : 'any'}</output></div>
    <input type="range" min="0" max="100" step="5" value="${F.dims[k] != null ? Math.round(F.dims[k]*100) : 50}" aria-label="${l}" class="${F.dims[k] != null ? 'set' : ''}"><div class="dimx"><span>${lo}</span><button class="link" data-clear="${k}">any</button><span>${hi}</span></div></div>`).join('');
  $$('#fDims .dim').forEach(d => { const k = d.dataset.k, inp = $('input', d);
    inp.oninput = () => { F.dims[k] = +inp.value / 100; inp.classList.add('set'); $('output', d).textContent = inp.value; renderBrowseSoon(); };
    $('[data-clear]', d).onclick = () => { delete F.dims[k]; inp.value = 50; inp.classList.remove('set'); $('output', d).textContent = 'any'; renderBrowse(); }; });
  $('#q').value = F.q; $('#minRating').value = F.minRating || 6; $('#ratingOut').textContent = F.minRating ? F.minRating.toFixed(1) + '+' : 'any';
  $('#yFrom').value = F.yFrom || ''; $('#yTo').value = F.yTo || ''; $('#hideSeen').checked = F.hideSeen; $('#sort').value = F.sort;
  $$('#srcChips .chip').forEach(b => b.setAttribute('aria-pressed', b.dataset.src === F.src));
}
let rbT; const renderBrowseSoon = () => { clearTimeout(rbT); rbT = setTimeout(renderBrowse, 160); };
function wireFilters(){
  let qT; $('#q').oninput = e => { clearTimeout(qT); qT = setTimeout(() => { F.q = e.target.value.trim(); if (!$('#view-browse').classList.contains('active')) switchView('browse'); else renderBrowse(); }, 280); };
  $('#minRating').oninput = e => { const v = +e.target.value; F.minRating = v <= 6 ? 0 : v; $('#ratingOut').textContent = F.minRating ? v.toFixed(1) + '+' : 'any'; renderBrowseSoon(); };
  $('#yFrom').oninput = e => { F.yFrom = +e.target.value || null; renderBrowseSoon(); };
  $('#yTo').oninput = e => { F.yTo = +e.target.value || null; renderBrowseSoon(); };
  $('#hideSeen').onchange = e => { F.hideSeen = e.target.checked; renderBrowse(); };
  $('#sort').onchange = e => { F.sort = e.target.value; renderBrowse(); };
  $$('#srcChips .chip').forEach(b => b.onclick = () => { if (b.dataset.src === 'live' && !LIVE) { toast('Live TMDB is offline right now'); return; } F.src = b.dataset.src; buildFilters(); renderBrowse(); });
  $('#resetFilters').onclick = () => { ['moods','genres','runtime','decades','flags'].forEach(k => F[k].clear()); F.dims = {}; Object.assign(F, { yFrom:null, yTo:null, minRating:0, q:'', sort:'match' }); buildFilters(); renderBrowse(); };
  $('#toggleFilters').onclick = () => { $('#filters').classList.toggle('open'); };
  $('#closeFilters').onclick = () => $('#filters').classList.remove('open');
  $('#loadMore').onclick = () => { if (F.src === 'live') loadLive(false); else { B.page++; drawBrowse(); } };
}
function browseCtx(){
  const target = Object.assign({}, ...[...F.moods].map(R.moodTarget), F.dims);
  const ml = F.moods.size ? listJoin([...F.moods].map(k => R.MOODS[k].label)) : '';
  return baseCtx({ target: Object.keys(target).length ? target : null, moodLabel: ml || (Object.keys(F.dims).length ? 'your sliders' : '') });
}
function catFilter(f){
  if (F.hideSeen && has('seen', f.id)) return false;
  if (rules.banInfo(f.id)) return false;
  if (F.q) { const q = F.q.toLowerCase(); if (!(f.t.toLowerCase().includes(q) || f.kw.some(k => k.includes(q)) || f.g.some(g => g.toLowerCase() === q))) return false; }
  if (F.moods.size && ![...F.moods].some(k => R.fitsMood(f, k))) return false;
  if (F.genres.size && !f.g.some(g => F.genres.has(g))) return false;
  if (F.runtime.size && ![...F.runtime].some(k => RUNTIMES[k].test(f.r))) return false;
  if (F.decades.size && ![...F.decades].some(k => f.y >= DECADES[k][0] && f.y <= DECADES[k][1])) return false;
  if (F.yFrom && f.y < F.yFrom) return false; if (F.yTo && f.y > F.yTo) return false;
  if (F.minRating && f.wr < F.minRating) return false;
  for (const k of F.flags) if (!FLAGS[k].test(f)) return false;
  for (const [k, t] of Object.entries(F.dims)) if (Math.abs((f.dims[k] ?? .5) - t) > .25) return false;
  return prefOK(f);
}
function renderBrowse(){
  if (!FILMS.length) return;
  B.page = 1; activeChips();
  if (F.src === 'live' && LIVE) { loadLive(true); return; }
  const ctx = browseCtx(); B.ctx = ctx;
  const list = FILMS.filter(catFilter);
  let ranked;
  const sorters = { rating:(a,b)=>b.f.wr-a.f.wr, new:(a,b)=>(b.f.y||0)-(a.f.y||0), old:(a,b)=>(a.f.y||0)-(b.f.y||0), short:(a,b)=>(a.f.r||999)-(b.f.r||999), az:(a,b)=>a.f.t.localeCompare(b.f.t) };
  if (F.sort === 'match') { const r = R.rank(list, ctx); const head = R.mmr(r, Math.min(24, r.length), .75, 150); const ids = new Set(head.map(x => x.f.id)); ranked = [...head, ...r.filter(x => !ids.has(x.f.id))]; }
  else ranked = list.map(f => R.relevance(f, ctx)).sort(sorters[F.sort]);
  B.list = ranked;
  drawBrowse();
  if (F.q && F.q.length >= 2 && LIVE) liveSearch(F.q);
}
function drawBrowse(){
  const ctx = B.ctx, shown = B.list.slice(0, B.page * PAGE), maxScore = Math.max(.01, ...shown.slice(0, 50).map(r => r.score));
  const filtering = F.moods.size || F.genres.size || Object.keys(F.dims).length || F.q;
  $('#resultCount').textContent = `${B.list.length.toLocaleString('en-GB')} film${B.list.length === 1 ? '' : 's'}${SOURCE === 'catalog' ? ' in catalogue' : ''}`;
  $('#results').innerHTML = shown.length ? shown.map(r => cardHTML(r.f, r, { ctx, match: filtering, maxScore })).join('') + '<div id="liveMore" class="livemore"></div>'
    : `<div class="empty">No films match all of that.<br>Remove a filter or hit Reset.</div><div id="liveMore" class="livemore"></div>`;
  $('#loadMore').hidden = B.list.length <= shown.length;
  afterRender($('#results'));
}
async function liveSearch(q){
  const tok = ++B.token;
  try {
    const res = await T.search(q, 1); if (tok !== B.token) return;
    const extra = res.items.filter(m => !BY_ID.has(m.id) || BY_ID.get(m.id).src === 'live').map(liveFilm).filter(f => !rules.banInfo(f.id) && prefOK(f));
    if (!extra.length) return;
    const ctx = B.ctx;
    $('#liveMore').innerHTML = `<h2 class="h2">More from TMDB <span class="muted">live search · ${res.total.toLocaleString('en-GB')} results</span></h2><div class="grid">${extra.map(f => cardHTML(f, R.relevance(f, ctx), { ctx })).join('')}</div>`;
    afterRender($('#liveMore'));
  } catch (e) { onLiveError(e); }
}
async function loadLive(reset){
  const tok = ++B.token; const L = B.live;
  if (reset) { L.items = []; L.page = 0; $('#results').innerHTML = '<div class="empty">Asking TMDB…</div>'; }
  const crit = { moods:F.moods, genres:F.genres, runtime:F.runtime, decades:F.decades, yFrom:F.yFrom, yTo:F.yTo, minRating:F.minRating, avoidGenres:store.genrePrefs.exclude, requireGenres:store.genrePrefs.require.length ? store.genrePrefs.require : null };
  try {
    const res = F.q ? await T.search(F.q, L.page + 1) : await T.discover(crit, { page: L.page + 1, pages: 2, sort: F.sort });
    if (tok !== B.token) return;
    L.page += F.q ? 1 : 2; L.pages = res.pages; L.total = res.total;
    const ids = new Set(L.items.map(f => f.id));
    L.items.push(...res.items.map(liveFilm).filter(f => !ids.has(f.id) && !rules.banInfo(f.id) && prefOK(f) && !(F.hideSeen && has('seen', f.id))));
    const ctx = B.ctx = browseCtx();
    $('#resultCount').textContent = `${L.total.toLocaleString('en-GB')} films · live TMDB${F.q ? ' search' : ''}`;
    $('#results').innerHTML = L.items.length ? L.items.map(f => cardHTML(f, R.relevance(f, ctx), { ctx })).join('') : '<div class="empty">TMDB has nothing for that combination.</div>';
    B.list = L.items.map(f => R.relevance(f, ctx));
    $('#loadMore').hidden = L.page >= L.pages;
    afterRender($('#results'));
  } catch (e) { onLiveError(e); F.src = 'cat'; buildFilters(); renderBrowse(); }
}
function activeChips(){
  const act = [];
  F.moods.forEach(k => act.push(['moods', k, R.MOODS[k].label])); F.genres.forEach(k => act.push(['genres', k, k]));
  F.runtime.forEach(k => act.push(['runtime', k, RUNTIMES[k].label])); F.decades.forEach(k => act.push(['decades', k, DECADES[k][2]]));
  F.flags.forEach(k => act.push(['flags', k, FLAGS[k].label]));
  Object.entries(F.dims).forEach(([k, v]) => act.push(['dims', k, `${SLIDERS.find(s => s[0] === k)[1]} ${Math.round(v * 100)}`]));
  if (F.minRating) act.push(['minRating', null, `★ ${F.minRating.toFixed(1)}+`]);
  store.genrePrefs.exclude.forEach(g => act.push(['gx', g, `No ${g}`]));
  $('#activeChips').innerHTML = act.map(([, , l], i) => `<button class="chip" aria-pressed="true" data-i="${i}">${esc(l)} ✕</button>`).join('');
  $$('#activeChips .chip').forEach(b => b.onclick = () => { const [g, k] = act[+b.dataset.i]; if (g === 'gx') { setGenre(k, 0); } else if (g === 'dims') delete F.dims[k]; else if (k !== null) F[g].delete(k); else if (g === 'minRating') F.minRating = 0; else F[g] = false; buildFilters(); renderBrowse(); });
}

/* ---------------- QUIZ ---------------- */
const QUIZ = [
  { k:'feel', q:'How are you feeling right now?', opts:[...Object.entries(R.FEELINGS).map(([k, v]) => ({ v:k, l:v.label, s:`valence ${Math.round(v.V*100)} · energy ${Math.round(v.A*100)}` })), { v:'*', l:'Not sure', s:'Just find something good' }] },
  { k:'mode', q:'Match your mood, or change it?', note:'Mood-management theory: people pick films to sustain a good mood or repair a bad one.', skipIf: () => qa.feel === '*',
    opts:[{ v:'match', l:'Match my mood', s:'Lean into how I feel' }, { v:'change', l:'Change my mood', s:'Shift me somewhere better' }] },
  { k:'who', q:"Who's watching?", opts:[{ v:'solo', l:'Just me', s:'My pick, my rules' }, { v:'date', l:'Date night', s:'Something for two' }, { v:'family', l:'Family / kids', s:'Nothing too dark' }, { v:'friends', l:'Mates', s:'Crowd-pleaser' }] },
  { k:'time', q:'How much time have you got?', opts:[{ v:'short', l:'Under 90 mins', s:'Quick one' }, { v:'mid', l:'Up to 2 hours', s:'Standard film' }, { v:'long', l:'All night', s:'Bring on the epic' }, { v:'*', l:"Doesn't matter", s:'' }] },
  { k:'era', q:'Old or new?', opts:[{ v:'classic', l:'Classics', s:'Before 2000' }, { v:'mid', l:'2000s–2010s', s:'Modern-ish' }, { v:'new', l:'Recent', s:'2018 onwards' }, { v:'*', l:'Any era', s:'' }] },
  { k:'genres', genres:true, q:'Anything you never want to see?', note:'Tap a genre to rule it out. Tap again (or long-press) to require it. Saved for Tonight, Browse and Surprise too.' },
  { k:'taste', q:'Last one: safe bet or something different?', opts:[{ v:'classic', l:'Safe bet', s:'Highly rated, proven' }, { v:'gem', l:'Something different', s:'Less obvious picks' }, { v:'*', l:'Either', s:'' }] },
];
let qi = 0; const qa = {}; let quizPicks = [], quizCtx = null, quizPool = null, quizFound = 0;
const QUIZ_N = 3, quizGone = new Set(); // films dismissed from the results (watchlist / seen / not interested): never shown again this visit
const resetQuizPicks = () => { quizPicks = []; quizPool = null; };
const qSkip = i => QUIZ[i] && QUIZ[i].skipIf && QUIZ[i].skipIf();
function renderQuiz(){
  while (qSkip(qi)) qi++;
  const el = $('#quiz'); if (qi >= QUIZ.length) return renderQuizResults();
  const step = QUIZ[qi];
  if (step.genres) {
    el.innerHTML = `<div class="progress"><i style="width:${qi / QUIZ.length * 100}%"></i></div><div class="qstep">Question ${qi + 1} of ${QUIZ.length}</div><h2 class="qh">${step.q}</h2><p class="muted">${step.note}</p>
      <div id="qGenres"></div><div class="qnav"><button class="btn" id="qBack">← Back</button><button class="btn primary" id="qNext">Next →</button></div>`;
    genreControl($('#qGenres'), () => {});
    $('#qBack').onclick = () => { qi = Math.max(0, qi - 1); while (qi > 0 && qSkip(qi)) qi--; renderQuiz(); };
    $('#qNext').onclick = () => { qi++; resetQuizPicks(); renderQuiz(); };
    return;
  }
  const isOn = v => step.multi ? qa[step.k].has(v) : qa[step.k] === v;
  el.innerHTML = `<div class="progress"><i style="width:${qi / QUIZ.length * 100}%"></i></div><div class="qstep">Question ${qi + 1} of ${QUIZ.length}</div><h2 class="qh">${step.q}</h2>${step.note ? `<p class="muted">${step.note}</p>` : ''}
    <div class="opts">${step.opts.map(o => `<button class="opt ${isOn(o.v) ? 'on' : ''}" data-v="${o.v}" aria-pressed="${isOn(o.v)}"><b>${o.l}</b>${o.s ? `<span class="s">${o.s}</span>` : ''}</button>`).join('')}</div>
    <div class="qnav"><button class="btn" id="qBack" ${qi === 0 ? 'style="visibility:hidden"' : ''}>← Back</button>${step.multi ? `<button class="btn primary" id="qNext">Next →</button>` : ''}</div>`;
  $$('.opt', el).forEach(b => b.onclick = () => { const v = b.dataset.v;
    if (step.multi) { const s = qa[step.k]; if (v === '*') s.clear(); else s.has(v) ? s.delete(v) : s.add(v); renderQuiz(); } else { qa[step.k] = v; qi++; renderQuiz(); } });
  $('#qBack').onclick = () => { qi = Math.max(0, qi - 1); while (qi > 0 && qSkip(qi)) qi--; renderQuiz(); };
}
function quizSetup(){
  const target = qa.feel && qa.feel !== '*' ? R.moodManagementTarget(qa.feel, qa.mode || 'match') : null;
  let zill = '';
  if (target) { const fl = R.FEELINGS[qa.feel].label.toLowerCase();
    zill = qa.mode === 'change' ? `You're ${fl} and want a change, so we aimed to repair the mood` : `You're ${fl} and want to stay there, so we matched it`; }
  const ctx = baseCtx({ target, zillmann: zill, prefer: qa.taste === '*' ? null : qa.taste });
  if (qa.who === 'date') ctx.target = Object.assign({ romance: .6 }, ctx.target || {});
  if (qa.who === 'friends') ctx.target = Object.assign({ humour: .6, pace: .7 }, ctx.target || {});
  const filter = f => (qa.who !== 'family' || (f.dims.family >= .6 && f.dims.scary < .4 && f.dims.violence < .45))
    && (qa.era !== 'classic' || f.y < 2000) && (qa.era !== 'mid' || (f.y >= 2000 && f.y <= 2017)) && (qa.era !== 'new' || f.y >= 2018)
    && (qa.who !== 'date' || f.dims.scary < .6);
  const runtime = qa.time && qa.time !== '*' ? new Set(qa.time === 'mid' ? ['short', 'mid'] : [qa.time]) : null;
  return { ctx, filter, runtime };
}
/* Ranked (MMR) pool: the first QUIZ_N are shown, the rest backfill when a pick is dismissed. MMR is greedy, so the first
   QUIZ_N are exactly what suggest(c, ctx, QUIZ_N) would return. Backfills are only marked as shown when they appear. */
function computeQuizPicks(){
  const { ctx, filter, runtime } = quizSetup(); quizCtx = ctx;
  const ok = f => !quizGone.has(f.id) && filter(f);
  let c = candidates({ runtime, filter: ok, minVotes: qa.taste === 'gem' ? 150 : 400 });
  if (c.length < QUIZ_N) c = candidates({ runtime, filter: ok });
  quizPool = suggest(c, ctx, QUIZ_N + 12, .7); quizFound = quizPool.length;
  quizPicks = quizPool.splice(0, QUIZ_N); rules.markShown(quizPicks.map(r => r.f.id));
}
const quizKeep = f => !quizGone.has(f.id) && !has('seen', f.id) && !rules.banInfo(f.id) && prefOK(f);
/* Drop dismissed / seen / hidden picks (the next one is promoted to Top pick) and backfill from the ranked pool. */
function settleQuizPicks(){
  quizPicks = quizPicks.filter(r => quizKeep(r.f));
  const ids = new Set(quizPicks.map(r => r.f.id)), added = [];
  while (quizPicks.length < QUIZ_N && quizPool.length) {
    const r = quizPool.shift();
    if (!ids.has(r.f.id) && quizKeep(r.f) && rules.eligible(r.f.id)) { r.fresh = true; quizPicks.push(r); ids.add(r.f.id); added.push(r.f.id); }
  }
  if (added.length) rules.markShown(added);
}
/* Result-card action that also removes the film: do its normal job, collapse the card, then re-render (which backfills). */
function dismissPick(a, id, card){
  if (card.classList.contains('leaving') || !getM(id)) return;
  if (a === 'notint') feedback('notint', id); else addToList(a, id);
  quizGone.add(id);
  collapseOut(card, () => refreshAll());
}
function collapseOut(el, done){
  let fin = false; const end = () => { if (!fin) { fin = true; done(); } };
  if (window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches) { el.classList.add('leaving'); return end(); }
  el.style.height = el.offsetHeight + 'px'; void el.offsetHeight; // pin the current height so it can animate to 0
  el.classList.add('leaving'); el.style.height = '0px';
  el.addEventListener('transitionend', e => { if (e.target === el && e.propertyName === 'height') end(); });
  setTimeout(end, 420);
}
function renderQuizResults(){
  if (!quizPool) computeQuizPicks(); else settleQuizPicks();
  const el = $('#quiz'), ctx = quizCtx;
  const none = quizFound ? `<div class="empty">That's every pick for these answers.<br>Shuffle for more, or start over.</div>` : '<div class="empty">Nothing new fits every answer. Try loosening one.</div>';
  el.innerHTML = `<div class="progress"><i style="width:100%"></i></div><div class="qstep">Your picks</div><h2 class="qh">Here's what we reckon</h2>
    <div class="quiz-results">${quizPicks.length ? quizPicks.map((r, i) => { const f = r.f, onW = has('watch', f.id); const html = `<div class="pick deal ${i === 0 ? 'first' : ''} ${r.fresh ? 'arrive' : ''}" data-id="${esc(f.id)}" data-dismiss>
      <div data-open>${posterHTML(f)}</div>
      <div><span class="eyebrow">${i === 0 ? 'Top pick' : 'Also great'}</span><h3 class="pt" data-open>${esc(f.t)}</h3>
      <div class="meta"><span class="star">★ ${f.wr.toFixed(1)}</span><span>${f.y || ''}</span><span data-run="${esc(f.id)}">${fmtRun(f.r)}</span><span>${esc(f.g.slice(0, 3).join(' · '))}</span></div>
      ${f.d ? `<p>${esc(f.d)}</p>` : ''}<div class="why"><b>Why this pick?</b> ${esc(R.why(r, ctx))}</div>
      <div class="actions pick-actions"><button class="btn sm ${onW ? 'on' : ''}" data-act="watch" title="Add to your watchlist and clear it from these picks">${onW ? 'On watchlist' : 'Watchlist'}</button><button class="btn sm" data-act="seen" title="Mark as seen and clear it from these picks">Seen it</button><button class="btn sm" data-act="notint" title="Hide for a year and clear it from these picks">Not interested</button></div>
      </div></div>`; r.fresh = false; return html; }).join('') : none}</div>
    <div class="qnav"><button class="btn" id="qRestart">↺ Start over</button><button class="btn primary" id="qShuffle" title="Counts as a skip for these picks">${ico('dice')} Shuffle picks</button></div>`;
  $('#qRestart').onclick = () => { qi = 0; for (const k in qa) delete qa[k]; resetQuizPicks(); renderQuiz(); };
  $('#qShuffle').onclick = () => { quizPicks.forEach(r => feedback('skip', r.f.id)); computeQuizPicks(); renderQuizResults(); };
  afterRender(el);
}

/* ---------------- SAVED ---------------- */
let savedList = 'watch';
function renderSaved(){
  if (savedList === 'hidden') {
    const bans = rules.state.bans; const ids = Object.keys(bans).filter(id => getM(id));
    $('#savedInfo').textContent = `${ids.length} hidden film${ids.length === 1 ? '' : 's'} (not interested or 3 skips). Each comes back after a year.`;
    $('#savedGrid').innerHTML = ids.length ? ids.map(id => { const f = getM(id), b = bans[id];
      return `<div class="cat" data-id="${esc(id)}"><div><div class="t">${esc(f.t)} <span class="muted">${f.y || ''}</span></div><div class="muted">${b.why === 'three-skips' ? '3 skips' : 'Not interested'} · until ${new Date(b.until).toLocaleDateString('en-GB')}</div></div><button class="btn sm" data-act="unban">Unhide</button></div>`; }).join('')
      : '<div class="empty">Nothing hidden.</div>';
    return;
  }
  const ids = store[savedList].filter(id => getM(id));
  const labels = { watch:'watchlist', fav:'favourites', seen:'seen list' };
  $('#savedInfo').textContent = `${ids.length} film${ids.length === 1 ? '' : 's'} in your ${labels[savedList]}`;
  $('#savedGrid').innerHTML = ids.length ? ids.slice().reverse().map(id => cardHTML(getM(id), null)).join('') : `<div class="empty">Nothing here yet. Tap ${savedList === 'seen' ? '“Seen it”' : 'the ' + (savedList === 'fav' ? 'heart' : 'pin')} on any film.</div>`;
  afterRender($('#savedGrid'));
}
$$('.saved-tabs .chip').forEach(b => b.onclick = () => { $$('.saved-tabs .chip').forEach(x => x.setAttribute('aria-pressed', x === b)); savedList = b.dataset.list; renderSaved(); });
function updateSavedCount(){ const n = store.watch.length, el = $('#savedCount'); el.textContent = n; el.hidden = !n; }

/* ---------------- FAB: context surprise ---------------- */
$('#fab').onclick = () => {
  const v = curView;
  if (v === 'browse') { if (!B.list.length) { toast('Nothing to pick from: loosen a filter'); return; } const pool = B.list.filter(r => rules.eligible(r.f.id)); if (!pool.length) { toast('Nothing new matches. Loosen a filter, or clear cooldowns in Settings'); return; } openPicker(R.mmr(pool, 20, .7, 80), 'Surprise me', B.ctx); }
  else if (v === 'saved') { const ctx = baseCtx(); const list = store[savedList === 'fav' ? 'fav' : 'watch'].map(getM).filter(f => f && !has('seen', f.id) && prefOK(f)).map(f => R.relevance(f, ctx)).sort((a, b) => b.score - a.score);
    openPicker(list, 'From your ' + (savedList === 'fav' ? 'favourites' : 'watchlist'), ctx); }
  else { $('#quickMoods [data-mood="*"]').click(); }
};


/* ---------------- PLEX ---------------- */
const ago = t => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? m + ' min ago' : m < 48 * 60 ? Math.round(m / 60) + 'h ago' : Math.round(m / 1440) + ' days ago'; };
const PF = { all:'All films', only:'Only on my Plex', hide:'Hide ones I own' };
function plexFilterHTML(){ return `<div class="chips wrap plexf" role="group" aria-label="Plex filter">${Object.entries(PF).map(([k, l]) => `<button class="chip" data-pf="${k}" aria-pressed="${store.plexFilter === k}">${l}</button>`).join('')}</div>`; }
function renderPlexBars(){
  const ready = P.libraryReady;
  const bar = $('#plexBar'); bar.hidden = !ready;
  if (ready) bar.innerHTML = `<span class="plexbar-l">${PLEXI}<b>Plex</b> <span class="muted">${P.library.count.toLocaleString('en-GB')} films on ${esc(P.library.servers.map(s => s.name).join(', '))}</span></span>${plexFilterHTML()}`;
  $('#fPlexGroup').hidden = !ready; if (ready) $('#fPlex').innerHTML = plexFilterHTML();
}
function setPlexFilter(v){
  if (!PF[v] || store.plexFilter === v) return;
  store.plexFilter = v; store.hero = null; store.row = null; save();
  renderPlexBars(); renderSettingsPlex(); refreshAll();
  toast(v === 'all' ? 'Showing all films' : v === 'only' ? 'Only films on your Plex server' : 'Hiding films you already own');
}
function updatePlexBits(){
  $$('[data-act="plexwl"]').forEach(b => { const c = b.closest('[data-id]'); const f = c && getM(c.dataset.id); if (!f) return;
    const on = P.onWatchlist(f.tmdb); b.classList.toggle('on', on); b.setAttribute('aria-pressed', on);
    if (b.classList.contains('starbtn')) { b.setAttribute('aria-label', on ? 'Remove from Plex watchlist' : 'Add to Plex watchlist'); b.title = on ? 'On your Plex watchlist' : 'Add to Plex watchlist'; }
    else { const sp = $('span', b); if (sp) sp.textContent = on ? 'On Plex watchlist' : 'Add to Plex watchlist'; } });
}
function togglePlexWL(id){ const f = getM(id); if (f && P.signedIn) plexSync(id, !P.onWatchlist(f.tmdb), true); }
/* Mirror a Watchlist action to the Plex watchlist when signed in. Toasts success, or a clear error with Retry. */
const plexBusy = new Set();
async function plexSync(id, on, explicit = false){
  const f = getM(id); if (!f || !P.signedIn) return;
  if (!f.tmdb && !f.imdb) { if (explicit) toast(`Can't match “${f.t}” on Plex (no TMDB/IMDb id)`); return; }
  const k = id + ':' + on; if (plexBusy.has(k)) return; plexBusy.add(k);
  const btns = () => $$('[data-act="plexwl"]').filter(b => { const c = b.closest('[data-id]'); return c && c.dataset.id === id; });
  btns().forEach(b => b.disabled = true);
  try {
    await P.setWatchlist({ tmdb: f.tmdb, imdb: f.imdb, t: f.t, y: f.y }, on);
    toast(on ? `Added to your Plex watchlist: ${f.t}` : `Removed from your Plex watchlist: ${f.t}`);
  } catch (e) {
    const retry = { label: 'Retry', run: () => plexSync(id, on, explicit) };
    if (e.status === 401 || !P.signedIn) toast('Plex sign-in expired: sign in again in Settings', { label: 'Settings', run: () => { closeModal(); $('#settingsBtn').click(); } });
    else if (e.status === 404) toast(`Couldn't find “${f.t}” on Plex, so it wasn't added to your Plex watchlist`, retry);
    else toast(`Plex watchlist ${on ? 'add' : 'remove'} failed (${e.status ? 'HTTP ' + e.status : e.name === 'AbortError' ? 'timed out' : 'network error'}): ${f.t}`, retry);
    if (typeof console !== 'undefined') console.warn('Plex watchlist', on ? 'add' : 'remove', 'failed:', e.status || e.name || 'error');
  } finally { plexBusy.delete(k); btns().forEach(b => b.disabled = false); updatePlexBits(); renderSettingsPlex(); }
}
const forwardUrl = () => location.origin + location.pathname + '#plexauth';
async function plexSignIn(){
  let pin = P.pendingPin(true), w = null;
  // Open the window synchronously inside the tap (popup blockers / iOS); fill in the URL once the pin exists.
  if (!pin || pin.exp - Date.now() < 5 * 60e3) { w = window.open('', 'plexauth'); try { pin = await P.preparePin(); } catch { if (w) w.close(); toast('Plex is unreachable right now'); return; } }
  P.begin(pin); const url = P.authUrl(pin, forwardUrl());
  if (w && !w.closed) { try { w.location.href = url; } catch { w = null; } } else w = window.open(url, 'plexauth');
  if (!w) { location.href = url; return; } // popup blocked: go to Plex in this window; forwardUrl brings us back
  P.startPolling(); renderSettingsPlex();
}
function plexLibLine(){
  const L = P.library, st = P.status.lib;
  if (st === 'loading' && !P.libraryReady) return '<span class="badge">Reading your library…</span>';
  if (st === 'noserver') return '<span class="badge warn">No server</span> This Plex account doesn\'t own a server.';
  if (!P.libraryReady) return `<span class="badge warn">Server unreachable</span> ${P.status.libError ? esc(P.status.libError) + '. ' : ''}${L && L.unreachable && L.unreachable.length ? esc(L.unreachable.join(', ')) + ' didn\'t answer. ' : ''}Turn on Remote Access in Plex Media Server (or use Reel Pick on the same Wi-Fi), then refresh.`;
  const via = [...new Set(L.servers.map(s => s.via))].join('/');
  return `<span class="badge ok">On my server</span> <b>${L.count.toLocaleString('en-GB')}</b> films on <b>${esc(L.servers.map(s => s.name).join(', '))}</b> <span class="muted">(${via}) · updated ${ago(L.t)}${st === 'loading' ? ' · refreshing…' : ''}</span>`
    + (st === 'stale' ? `<br><span class="badge warn">Couldn't refresh</span> showing the last copy.` : '')
    + (L.unreachable && L.unreachable.length ? `<br><span class="muted">${esc(L.unreachable.join(', '))} didn't answer.</span>` : '');
}
function plexPanelHTML(){
  if (!P.signedIn) {
    const pin = P.pendingPin();
    return `<h3 class="h2">Plex</h3><p class="muted">Sign in to add films to your Plex watchlist and see which ones are already on your server. Your Plex sign-in stays in this browser only.</p>
      ${pin ? `<p class="muted" id="plexWait"><span class="badge warn">Waiting for Plex…</span> Finish signing in on the Plex page, then come back here.</p>
        <div class="row2"><button class="btn primary" id="plexSignIn">Open Plex sign-in again</button><button class="btn" id="plexCancel">Cancel</button></div>`
        : `<button class="btn primary plexsign" id="plexSignIn">${PLEXI}<span>Sign in with Plex</span></button>`}`;
  }
  const u = P.user, W = P.watchlist;
  return `<h3 class="h2">Plex</h3><p class="muted" id="plexUser"><span class="badge ok">Signed in</span> ${u ? `as <b>${esc(u.name)}</b>` : ''}</p>
    <p class="muted" id="plexLib">${plexLibLine()}</p>
    <p class="muted" id="plexWl">Plex watchlist: <b>${W ? W.count : '…'}</b> film${W && W.count === 1 ? '' : 's'}${P.status.wl === 'error' ? ' <span class="badge warn">couldn\'t load</span>' : ''}</p>
    ${P.libraryReady ? `<p class="muted tiny">Show in Tonight & Browse:</p>${plexFilterHTML()}` : ''}
    <div class="row2"><button class="btn" id="plexRefresh">Refresh library</button><button class="btn" id="plexSignOut">Sign out</button></div>`;
}
function renderSettingsPlex(){
  const el = $('#setPlex'); if (!el) return;
  el.innerHTML = plexPanelHTML();
  const si = $('#plexSignIn', el); if (si) si.onclick = plexSignIn;
  const ca = $('#plexCancel', el); if (ca) ca.onclick = () => P.cancelSignIn();
  const rf = $('#plexRefresh', el); if (rf) rf.onclick = () => { P.refreshLibrary(true).catch(() => {}); P.refreshWatchlist(true).catch(() => {}); };
  const so = $('#plexSignOut', el); if (so) so.onclick = () => { P.signOut(); toast('Signed out of Plex'); };
}
let plexRT; const refreshSoon = () => { clearTimeout(plexRT); plexRT = setTimeout(() => refreshAll(true), 120); };
P.on(what => {
  if (what === 'expired') toast('Plex sign-in expired: sign in again in Settings');
  if (what === 'auth' || what === 'expired') { if (P.signedIn) toast('Signed in to Plex'); renderPlexBars(); renderSettingsPlex(); refreshSoon(); }
  else if (what === 'library') { renderPlexBars(); renderSettingsPlex(); if (P.status.lib !== 'loading') refreshSoon(); }
  else if (what === 'watchlist') { updatePlexBits(); renderSettingsPlex(); }
  else if (what === 'pin') renderSettingsPlex();
});
function plexResume(){
  if (!P.signedIn) { if (P.pendingPin()) { P.checkPin(); P.startPolling(); } return; }
  if (P.wlStale()) P.refreshWatchlist().catch(() => {});
  if (P.libStale()) P.refreshLibrary().catch(() => {});
}
window.addEventListener('storage', e => { if (e.key && e.key.startsWith('reelpick.plex')) P.reload(); });
/* The auth popup may lose window.opener (cross-origin navigation / COOP on app.plex.tv), so it asks over a BroadcastChannel
   whether an app window is already open. If one answers, the popup just finishes the PIN and closes. */
const plexBC = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('reelpick-plex') : null;
const IS_RETURN = location.hash.startsWith('#plexauth');
if (plexBC) plexBC.onmessage = e => { if (e.data === 'ping' && !IS_RETURN) plexBC.postMessage('here'); if (e.data === 'done') P.reload(); };
function isPlexPopup(){
  if (window.opener && window.opener !== window) return Promise.resolve(true);
  if (!plexBC) return Promise.resolve(false);
  return new Promise(res => { const h = e => { if (e.data === 'here') { plexBC.removeEventListener('message', h); res(true); } };
    plexBC.addEventListener('message', h); plexBC.postMessage('ping'); setTimeout(() => { plexBC.removeEventListener('message', h); res(false); }, 450); });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') plexResume(); });
window.addEventListener('pageshow', plexResume); window.addEventListener('focus', plexResume);

/* ---------------- settings ---------------- */
$('#settingsBtn').onclick = () => {
  modalState = null; picker = null; const rs = rules.stats();
  const status = LIVE ? `<span class="badge ok">TMDB live</span>` : `<span class="badge warn">TMDB offline</span>`;
  const jevN = FILMS.filter(f => f.jev).length;
  openModal(`<div class="settings">
    <div class="panel plexpanel" id="setPlex"></div>
    <div class="panel"><h3 class="h2">Genres</h3><p class="muted">Tap to rule a genre out, tap again (or long-press) to require it, tap a third time to clear. Applied everywhere.</p><div id="setGenres"></div></div>
    <div class="panel"><h3 class="h2">Data</h3><p class="muted">${status} ${SOURCE === 'catalog' ? `<span class="badge">${FILMS.length.toLocaleString('en-GB')} film catalogue</span> <span class="badge">${jevN ? jevN.toLocaleString('en-GB') + ' scored by Jev' : 'Mood scores estimated'}</span>` : '<span class="badge warn">Offline list · 170 films</span>'}</p>
      ${STATS ? `<p class="muted">Live TMDB reach: ${STATS.all.toLocaleString('en-GB')}+ films with 10+ votes.</p>` : ''}
      <label class="muted" for="tmdbKey">Own TMDB key (optional override)</label><input type="password" id="tmdbKey" autocomplete="off" placeholder="${(window.REELPICK_CONFIG || {}).tmdbKey ? 'Using the built-in key' : 'v3 API key or v4 read token'}" value="${esc(store.tmdbKey)}">
      <div class="row2"><button class="btn" id="saveKey">Save key</button><button class="btn" id="exportData">Export my lists</button></div></div>
    <div class="panel"><h3 class="h2">Suggestion rules</h3><p class="muted">Suggested films rest for 30 days. Three skips, or “Not interested”, hides a film for a year. No repeats within a visit.</p>
      <p class="muted"><b>${rs.cooldown}</b> on cooldown · <b>${rs.banned}</b> hidden · <b>${rs.struck}</b> with strikes · taste profile from <b>${store.fb.length + store.fav.length + store.watch.length}</b> signals</p>
      <div class="row2"><button class="btn" id="clearRules">Clear cooldowns & hidden</button><button class="btn" id="clearTaste">Reset taste profile</button></div>
      <button class="btn" id="wipe">Reset everything</button></div>
    <p class="tiny muted">This product uses the TMDB API but is not endorsed or certified by TMDB.</p></div>`, false, 'Settings');
  genreControl($('#setGenres'), () => { buildFilters(); refreshAll(); });
  renderSettingsPlex(); if (!P.signedIn) P.preparePin().catch(() => {});
  $('#saveKey').onclick = async () => { store.tmdbKey = $('#tmdbKey').value.trim(); save(); closeModal(); await startLive(); toast(LIVE ? 'TMDB live' : 'TMDB key not accepted, offline mode'); refreshAll(); };
  $('#exportData').onclick = () => { const n = id => (getM(id) || {}).t; const out = { watchlist: store.watch.map(n), favourites: store.fav.map(n), seen: store.seen.map(n), liked: store.fb.filter(e => e.type === 'like').map(e => n(e.id)) };
    const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(out, null, 2)], { type:'application/json' })); a.download = 'reelpick-lists.json'; a.click(); };
  $('#clearRules').onclick = () => { rules.reset(); store.hero = null; store.row = null; save(); toast('Cooldowns and hidden films cleared'); closeModal(); refreshAll(); };
  $('#clearTaste').onclick = () => { store.fb = []; save(); recomputeProfile(); toast('Taste profile reset'); closeModal(); refreshAll(); };
  $('#wipe').onclick = () => { if (confirm('Clear lists, taste profile, rules and settings?')) { localStorage.removeItem(LS_KEY); rules.reset(); P.signOut(); location.reload(); } };
};

/* ---------------- views ---------------- */
const TITLES = { tonight:['Reel Pick', () => 'tonight · ' + new Date().toLocaleDateString('en-GB', { weekday:'long' }).toLowerCase()], quiz:['Quiz', () => 'mood · company · time · taste'],
  browse:['Browse', () => `${FILMS.length.toLocaleString('en-GB')} films${LIVE ? ' · tmdb live' : ''}`], saved:['Saved', () => 'watchlist · favourites · hidden'] };
let curView = 'tonight';
function switchView(v){
  if (!$('#modal').hidden) closeModal();
  $('#filters').classList.remove('open');
  curView = v;
  $$('.tabs button').forEach(t => t.classList.toggle('active', t.dataset.view === v));
  $$('.view').forEach(s => s.classList.toggle('active', s.id === 'view-' + v));
  $('#title').textContent = TITLES[v][0]; $('#sub').textContent = TITLES[v][1]();
  $('#fab').classList.toggle('hide', v === 'quiz');
  if (v === 'saved') renderSaved(); if (v === 'quiz') renderQuiz(); if (v === 'browse') renderBrowse();
  if (!(history.state && history.state.rpModal)) history.replaceState(null, '', '#' + v); window.scrollTo({ top: 0 });
}
$$('.tabs button').forEach(t => t.onclick = () => switchView(t.dataset.view));
function refreshAll(soft = false){
  if (curView === 'browse') { if (soft && F.src === 'live') {} else renderBrowse(); }
  if (curView === 'saved') renderSaved();
  if (curView === 'quiz' && qi >= QUIZ.length) renderQuizResults();
  renderTonightRow(); renderHero();
  if (!$('#modal').hidden && modalState && modalState.f) { const { f, rr, title, again, ctx } = modalState; const p = picker; showDetail(f, rr, title, again, ctx, true); picker = p; }
  footer();
}
function footer(){
  const src = SOURCE === 'catalog'
    ? `${FILMS.length.toLocaleString('en-GB')}-film catalogue built ${META.built.slice(0, 10)}${META.jev_scored ? ` · mood scores by TypeSafe Jev` : ' · mood scores estimated from genres & keywords'}`
    : 'Offline list of 170 curated films';
  const live = LIVE ? ` · TMDB live${STATS ? `: ${STATS.all.toLocaleString('en-GB')}+ films reachable` : ''}` : ' · TMDB offline';
  $('#foot').innerHTML = `${esc(src)}${esc(live)}.<br>Film data & images from TMDB. This product uses the TMDB API but is not endorsed or certified by TMDB.`;
  $('#sub').textContent = TITLES[curView][1]();
}
function onLiveError(e){ if (e && e.status === 401) { LIVE = false; toast('TMDB key rejected: offline mode'); footer(); } else if (!onLiveError.t) { onLiveError.t = 1; toast('TMDB unreachable: showing catalogue data'); } }
T.onAuthFail = () => { LIVE = false; footer(); };
async function startLive(){
  LIVE = await T.init(store.tmdbKey); footer();
  if (LIVE) T.stats().then(s => { STATS = s; footer(); }).catch(() => {});
}

/* ---------------- init ---------------- */
(async function init(){
  if (location.hash.startsWith('#plexauth') && await isPlexPopup()) {
    // We are the Plex sign-in popup landing on forwardUrl: finish the PIN check and close; the app window picks up the token.
    document.body.innerHTML = '<p class="empty" style="margin:40vh auto 0;text-align:center">Signed in to Plex. You can close this window.</p>';
    try { await P.checkPin(); } catch {} try { plexBC && plexBC.postMessage('done'); } catch {}
    setTimeout(() => window.close(), 400); document.documentElement.dataset.ready = '1'; return;
  }
  $('#hero').innerHTML = '<div class="empty">Loading films…</div>';
  await Promise.all([loadData(), startLive()]);
  buildFilters(); wireFilters(); renderPlexBars(); renderQuickMoods(); renderHero(); renderTonightRow(); updateSavedCount(); footer();
  const back = location.hash.startsWith('#plexauth');
  const start = (location.hash || '').slice(1);
  if (['tonight', 'quiz', 'browse', 'saved'].includes(start)) switchView(start); else switchView('tonight');
  loadOverviews();
  if (back) { // returned from app.plex.tv in this window (redirect, or Safari opened from the home-screen app)
    if (P.pendingPin()) { P.checkPin(); P.startPolling(); }
    else if (!P.signedIn) toast('Plex sign-in finished. If you started in the Reel Pick home-screen app, switch back to it.');
  }
  setTimeout(plexResume, 1200); setInterval(plexResume, 30 * 60e3);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
  document.documentElement.dataset.ready = '1';
})();
window.ReelPick = { get films(){ return FILMS; }, store, rules, plex: P, get live(){ return LIVE; }, get source(){ return SOURCE; }, get stats(){ return STATS; }, getM };
})();
