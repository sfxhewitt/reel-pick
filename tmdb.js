/* Reel Pick: live TMDB v3 data layer. Discover/search films, posters, ratings, cast and trailers (no streaming-provider data).
   Key comes from config.js (generated from $TMDB_API_KEY) or an optional override saved in Settings.
   Without a working key everything falls back to the curated offline list in data.js. */
(() => {
'use strict';
const API = 'https://api.themoviedb.org/3', IMG = 'https://image.tmdb.org/t/p/', REGION = 'GB';


let GENRES = {28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentary',18:'Drama',10751:'Family',
  14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-Fi',10770:'TV Movie',53:'Thriller',10752:'War',37:'Western'};
const GID = () => Object.fromEntries(Object.entries(GENRES).map(([id,n])=>[n,+id]));

/* Moods -> TMDB genre (OR) + excluded genres + flavour keywords (keyword ids resolved live via /search/keyword). */
const MOOD_Q = {
  fg:{g:[35,10751,16,10749,10402], x:[27,53,10752,80],    kw:['feel-good','heartwarming','friendship','uplifting']},
  th:{g:[53,80,9648],              x:[16,10751,35],       kw:['suspense','psychological thriller','cat and mouse','neo-noir']},
  cr:{g:[18],                      x:[35,27,28,878],      kw:['tearjerker','grief','loss of loved one','terminal illness']},
  la:{g:[35],                      x:[27,10752,18],       kw:['parody','slapstick comedy','satire','buddy comedy']},
  mb:{g:[878,9648],                x:[10751,16,35],       kw:['mind-bending','plot twist','nonlinear timeline','time loop','dream']},
  ch:{g:[35,10749,16,10751,99],    x:[27,53,10752,80,28], kw:['cozy','small town','coming of age','road trip']},
  ad:{g:[28,12],                   x:[10749,99,18],       kw:['high octane','chase','heist','car chase']},
};
const RUNTIME_Q = {short:[40,89], mid:[90,120], long:[121,400]};
const DECADE_Q = {'70s':[1900,1979],'80s':[1980,1989],'90s':[1990,1999],'00s':[2000,2009],'10s':[2010,2019],'20s':[2020,2099]};

let key = '', bearer = false, live = false, lastError = null;
function setKey(k){ key = (k||'').trim(); bearer = key.startsWith('eyJ'); }

/* ---------- fetch with in-memory de-dupe cache ---------- */
const mem = new Map();
function get(path, params = {}){
  const qp = new URLSearchParams(Object.entries(params).filter(([,v])=>v!==undefined && v!=='' && v!==null));
  const ck = path + '?' + qp;
  if (mem.has(ck)) return mem.get(ck);
  if (!bearer) qp.set('api_key', key);
  const p = fetch(API + path + '?' + qp, bearer ? {headers:{Authorization:'Bearer '+key, accept:'application/json'}} : {})
    .then(async r => { if (!r.ok) { const e = new Error('TMDB HTTP '+r.status); e.status = r.status; throw e; } return r.json(); });
  mem.set(ck, p); p.catch(()=>mem.delete(ck));
  if (mem.size > 400) mem.delete(mem.keys().next().value);
  return p;
}

/* ---------- persistent light cache (runtime) ---------- */
const LC = 'reelpick.tcache.v2', TTL = 12*3600e3;
let lcache = {}; try { lcache = JSON.parse(localStorage.getItem(LC)) || {}; } catch {}
let lcT; function lsave(){ clearTimeout(lcT); lcT = setTimeout(()=>{ try{
  const ks = Object.keys(lcache); if (ks.length > 700) ks.sort((a,b)=>lcache[a].t-lcache[b].t).slice(0, ks.length-600).forEach(k=>delete lcache[k]);
  localStorage.setItem(LC, JSON.stringify(lcache)); }catch{} }, 400); }

/* ---------- normalisation ---------- */
function moodsFor(g){
  const h = x => g.includes(x), m = [];
  const dark = h('Horror')||h('Thriller')||h('War')||h('Crime');
  if (h('Action')||h('Adventure')||h('War')||h('Western')) m.push('ad');
  if (h('Thriller')||h('Horror')||h('Crime')||h('Mystery')) m.push('th');
  if (h('Comedy')) m.push('la');
  if (!dark && (h('Comedy')||h('Family')||h('Animation')||h('Romance')||h('Music'))) m.push('fg');
  if (h('Sci-Fi')||h('Mystery')) m.push('mb');
  if (h('Drama') && !h('Comedy') && (h('Romance')||h('War')||h('History')||g.length<=2)) m.push('cr');
  if (!dark && !h('Action') && (h('Comedy')||h('Romance')||h('Family')||h('Animation')||h('Documentary'))) m.push('ch');
  return m.length ? m : ['ch'];
}
function norm(r){
  const g = (r.genre_ids || (r.genres||[]).map(x=>x.id)).map(id=>GENRES[id]).filter(n=>n && n!=='TV Movie');
  const m = { id:'tmdb-'+r.id, tmdb:r.id, src:'tmdb', t:r.title||r.original_title||'Untitled', y:+(r.release_date||'').slice(0,4)||null,
    r:r.runtime||null, i:Math.round((r.vote_average||0)*10)/10, votes:r.vote_count||0, g, m:moodsFor(g), d:r.overview||'',
    poster:r.poster_path?IMG+'w342'+r.poster_path:'', backdrop:r.backdrop_path?IMG+'w1280'+r.backdrop_path:'' };
  const c = lcache[m.id]; if (c && Date.now()-c.t < TTL) applyLight(m, c);
  return m;
}
function applyLight(m, c){ if (c.r) m.r = c.r; }

/* ---------- query building ---------- */
const kwCache = {};
async function keywordIds(mood){
  if (kwCache[mood]) return kwCache[mood];
  const names = MOOD_Q[mood].kw;
  const ids = (await Promise.all(names.map(n => get('/search/keyword', {query:n}).then(j => {
    const hit = (j.results||[]).find(r => r.name.toLowerCase() === n.toLowerCase()); return hit ? hit.id : null; }).catch(()=>null)))).filter(Boolean);
  return (kwCache[mood] = ids);
}
const today = () => new Date().toISOString().slice(0,10);
async function discoverParams(c, o = {}){
  const gid = GID();
  const p = { language:'en-GB', include_adult:false, include_video:false, 'vote_count.gte': o.minVotes ?? 150, 'with_runtime.gte': 40 };
  let withG = null, without = new Set((c.avoidGenres||[]).map(n=>gid[n]).filter(Boolean));
  const moods = c.moods ? [...c.moods] : [];
  if (c.genres && c.genres.size) withG = [...c.genres].map(n=>gid[n]).filter(Boolean);
  else if (moods.length) withG = [...new Set(moods.flatMap(k=>MOOD_Q[k].g))];
  if (moods.length === 1) MOOD_Q[moods[0]].x.forEach(x => without.add(x));
  if (c.requireGenres){ const req = c.requireGenres.map(n=>gid[n]).filter(Boolean); const inter = withG ? withG.filter(x=>req.includes(x)) : []; withG = inter.length ? inter : req; }
  if (withG) { withG.forEach(x=>without.delete(x)); p.with_genres = withG.join('|'); }
  if (without.size) p.without_genres = [...without].join(',');
  if (c.runtime && c.runtime.size){ const r = [...c.runtime].map(k=>RUNTIME_Q[k]); p['with_runtime.gte'] = Math.min(...r.map(x=>x[0])); p['with_runtime.lte'] = Math.max(...r.map(x=>x[1])); }
  let yF = c.yFrom||null, yT = c.yTo||null;
  if (c.decades && c.decades.size){ const d = [...c.decades].map(k=>DECADE_Q[k]); yF = Math.max(yF||0, Math.min(...d.map(x=>x[0]))); yT = Math.min(yT||9999, Math.max(...d.map(x=>x[1]))); }
  if (yF) p['primary_release_date.gte'] = yF + '-01-01';
  p['primary_release_date.lte'] = yT ? `${Math.min(yT, 2100)}-12-31` : today();
  if (c.minRating) p['vote_average.gte'] = c.minRating;
  if (o.keywords && moods.length === 1){ const k = await keywordIds(moods[0]); if (k.length) p.with_keywords = k.join('|'); }
  if (c.prefer === 'classic') p['vote_count.gte'] = Math.max(p['vote_count.gte'], 2000);
  if (c.prefer === 'gem'){ p['vote_count.gte'] = 150; p['vote_count.lte'] = 2500; p['vote_average.gte'] = Math.max(c.minRating||0, 6.8); }
  const sort = o.sort || 'match';
  p.sort_by = {match:'popularity.desc', rating:'vote_average.desc', new:'primary_release_date.desc', old:'primary_release_date.asc', short:'popularity.desc', az:'title.asc'}[sort] || 'popularity.desc';
  if (sort === 'rating') p['vote_count.gte'] = Math.max(p['vote_count.gte'], 1000);
  if (sort === 'old' || sort === 'az') p['vote_count.gte'] = Math.max(p['vote_count.gte'], 300);
  return p;
}

/* ---------- public API ---------- */
async function discover(c, o = {}){
  const p = await discoverParams(c, o);
  const pages = o.pages || 1, start = o.page || 1;
  const js = await Promise.all(Array.from({length:pages}, (_,i) => get('/discover/movie', {...p, page:start+i})));
  const items = []; const ids = new Set();
  const moods = c.moods ? [...c.moods] : [];
  for (const j of js) for (const r of j.results||[]) if (!ids.has(r.id)) { ids.add(r.id); const m = norm(r); if (moods.length===1 && !m.m.includes(moods[0])) m.m.unshift(moods[0]); items.push(m); }
  return { items, total: js[0].total_results||0, pages: Math.min(js[0].total_pages||0, 500) };
}
async function search(q, page = 1){
  const j = await get('/search/movie', {query:q, page, include_adult:false, language:'en-GB'});
  return { items:(j.results||[]).map(norm), total:j.total_results||0, pages:Math.min(j.total_pages||0, 500) };
}
/* Light enrichment for live results: runtime (cached 12h). Full=true adds credits, trailer, tagline. */
async function details(m, full = false){
  if (!live) return m;
  if (!m.tmdb){ // offline-list film: find it on TMDB by title + year
    const j = await get('/search/movie', {query:m.t.replace(/·/g,''), year:m.y, include_adult:false});
    const hit = (j.results||[])[0]; if (!hit) return m;
    m.tmdb = hit.id; if (hit.poster_path) m.poster = IMG+'w342'+hit.poster_path; if (hit.backdrop_path) m.backdrop = IMG+'w1280'+hit.backdrop_path;
    if (hit.vote_average) m.tmdbRating = Math.round(hit.vote_average*10)/10;
  }
  const c = lcache[m.id];
  if (!full && c && Date.now()-c.t < TTL) { applyLight(m, c); return m; }
  // Full detail also asks for UK watch providers (TMDB's JustWatch data, same key) so the sheet can show where it streams in the UK.
  const d = await get('/movie/'+m.tmdb, full ? {language:'en-GB', append_to_response:'credits,videos,watch/providers'} : {language:'en-GB'});
  m.r = d.runtime || m.r; m.imdb = d.imdb_id || m.imdb;
  if (m.src === 'tmdb'){ if (d.overview) m.d = d.overview; if (d.genres) { m.g = d.genres.map(x=>GENRES[x.id]||x.name).filter(n=>n!=='TV Movie'); } }
  if (d.poster_path && !m.poster) m.poster = IMG+'w342'+d.poster_path;
  if (d.backdrop_path) m.backdrop = IMG+'w1280'+d.backdrop_path;
  lcache[m.id] = {t:Date.now(), r:m.r}; lsave();
  if (full){
    const vids = (d.videos||{}).results||[];
    const vid = vids.find(v=>v.site==='YouTube' && v.type==='Trailer' && v.official) || vids.find(v=>v.site==='YouTube' && v.type==='Trailer');
    m.extra = { tagline:d.tagline||'', director:((d.credits||{}).crew||[]).filter(x=>x.job==='Director').map(x=>x.name).slice(0,2),
      cast:((d.credits||{}).cast||[]).slice(0,10).map(x=>({n:x.name, c:x.character, p:x.profile_path?IMG+'w185'+x.profile_path:''})),
      trailer: vid ? 'https://www.youtube.com/watch?v='+vid.key : '',
      watch: (() => { const gb = ((d['watch/providers']||{}).results||{}).GB; if (!gb) return null; const pick = k => (gb[k]||[]).slice(0,6).map(p=>({n:p.provider_name, l:p.logo_path?IMG+'w92'+p.logo_path:''}));
        return { link: gb.link||'', stream: pick('flatrate').concat(pick('free'), pick('ads')), rent: pick('rent') }; })() };
  }
  return m;
}
/* small concurrency-limited queue for card enrichment */
const q = []; let active = 0; const queued = new Set();
function enqueue(m, cb){
  if (!live || queued.has(m.id)) return; queued.add(m.id); q.push([m, cb]); pump();
}
function pump(){
  while (active < 6 && q.length){
    const [m, cb] = q.shift(); active++;
    details(m).then(() => cb && cb(m), e => { if (e && e.status === 401) onAuthFail(); queued.delete(m.id); })
      .finally(() => { active--; pump(); });
  }
}
let authFail = null; function onAuthFail(){ live = false; authFail && authFail(); }

async function init(override){
  setKey(override || ((window.REELPICK_CONFIG||{}).tmdbKey) || '');
  live = false; lastError = null; mem.clear();
  if (!key) { lastError = 'no-key'; return false; }
  try {
    const g = await get('/genre/movie/list', {language:'en'});
    (g.genres||[]).forEach(x => { GENRES[x.id] = x.id===878 ? 'Sci-Fi' : x.name; });
    live = true; return true;
  } catch (e) { lastError = e.status === 401 ? 'rejected' : 'network'; return false; }
}
/* Reachable-title counts. TMDB caps total_results at ~20k per query, so count in release-year bands and sum. Cached 24h. */
const BANDS = [['1900','1959'],['1960','1979'],['1980','1989'],['1990','1999'],['2000','2006'],['2007','2009'],['2010','2013'],['2014','2016'],['2017','2020'],['2021','2023'],['2024','2027']];
async function stats(){
  try { const c = JSON.parse(localStorage.getItem('reelpick.tstats2') || 'null'); if (c && Date.now() - c.t < 864e5) return c.v; } catch {}
  const base = {include_adult:false, include_video:false};
  const band = ([a, b]) => ({'primary_release_date.gte': a + '-01-01', 'primary_release_date.lte': b + '-12-31'});

  const count = ps => Promise.all(ps.map(p => get('/discover/movie', p).then(j => j.total_results || 0))).then(a => ({n: a.reduce((x, y) => x + y, 0), capped: a.some(x => x >= 20000)}));
  const all = await count(BANDS.map(b => ({...base, 'vote_count.gte': 10, ...band(b)})));
  const v = { all: all.n, capped: all.capped };
  try { localStorage.setItem('reelpick.tstats2', JSON.stringify({t: Date.now(), v})); } catch {}
  return v;
}

window.TMDB = { MOOD_Q, init, discover, search, details, enqueue, stats, moodsFor,
  get live(){ return live; }, get error(){ return lastError; }, get usingOverride(){ return false; },
  set onAuthFail(f){ authFail = f; }, genreNames: () => Object.values(GENRES).filter(n=>n!=='TV Movie').sort(), keyKind: () => key ? (bearer?'v4 token':'v3 key') : 'none' };
})();
