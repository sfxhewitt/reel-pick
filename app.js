/* Reel Pick — movie chooser. Pure JS, no build step, works offline from file:// */
(() => {
'use strict';

// ---------- constants ----------
const MOODS = {
  fg:{label:'Feel-good', e:'☀️', s:'Warm & uplifting'},
  th:{label:'Thriller',  e:'🔪', s:'Edge of your seat'},
  cr:{label:'Have a cry',e:'😢', s:'Bring tissues'},
  la:{label:'Laugh',     e:'😂', s:'Proper funny'},
  mb:{label:'Mind-bender',e:'🌀',s:'Twisty & clever'},
  ch:{label:'Chill',     e:'🛋️', s:'Cosy, low effort'},
  ad:{label:'Adrenaline',e:'⚡', s:'Big, loud, fast'},
};
const SERVICES = {
  N:{name:'Netflix',    short:'NETFLIX', color:'#e50914'},
  P:{name:'Prime Video',short:'PRIME',   color:'#00a8e1'},
  D:{name:'Disney+',    short:'DISNEY+', color:'#1a3fd0'},
  M:{name:'Max',        short:'MAX',     color:'#5a2ee6'},
  A:{name:'Apple TV+',  short:'TV+',     color:'#4a4a52'},
  S:{name:'Now / Sky',  short:'NOW',     color:'#00a596'},
};
const RUNTIMES = {
  short:{label:'Under 90 min', test:r=>r<90},
  mid:  {label:'90–120 min',   test:r=>r>=90 && r<=120},
  long: {label:'2h+',          test:r=>r>120},
};
const DECADES = {
  '70s':[1900,1979,'70s & earlier'],'80s':[1980,1989,'80s'],'90s':[1990,1999,'90s'],
  '00s':[2000,2009,'2000s'],'10s':[2010,2019,'2010s'],'20s':[2020,2099,'2020s'],
};
const GENRE_GLYPH = {Action:'💥',Adventure:'🧭',Animation:'✏️',Comedy:'🎭',Crime:'🕵️',Drama:'🎞️',Family:'🧸',
  Fantasy:'🐉',Horror:'🩸',Mystery:'🔎',Romance:'💘',['Sci-Fi']:'🚀',Thriller:'🔪',War:'🎖️',Musical:'🎵'};

// ---------- data ----------
const slug = s => s.toLowerCase().normalize('NFD').replace(/[^\w]+/g,'-').replace(/^-|-$/g,'');
const MOVIES = (window.MOVIES_RAW||[]).map(([t,y,r,i,g,m,s,d]) => ({
  id: slug(t+'-'+y), t, y, r, i, g:g.split(' '), m:m.split(' '), s:s?s.split(' '):[], d
}));
const BY_ID = Object.fromEntries(MOVIES.map(m=>[m.id,m]));
const ALL_GENRES = [...new Set(MOVIES.flatMap(m=>m.g))].sort();

// ---------- persistence ----------
const LS_KEY = 'reelpick.v1';
const store = Object.assign({fav:[],watch:[],seen:[],services:[],tmdbKey:'',posters:{},extra:{}}, (()=>{
  try { return JSON.parse(localStorage.getItem(LS_KEY))||{}; } catch { return {}; }
})());
const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(store)); } catch {} updateSavedCount(); };
const has = (list,id) => store[list].includes(id);
function toggleList(list,id){
  const i = store[list].indexOf(id);
  if(i>=0) store[list].splice(i,1); else store[list].push(id);
  if(list==='seen' && i<0){ const w=store.watch.indexOf(id); if(w>=0) store.watch.splice(w,1); }
  save();
  const m = BY_ID[id];
  const msgs = {fav:['♥ Added to favourites','Removed from favourites'],watch:['📌 Added to watchlist','Removed from watchlist'],seen:['✓ Marked as seen','Unmarked as seen']};
  toast(`${i<0?msgs[list][0]:msgs[list][1]} — ${m.t}`);
  refreshAll();
}

// ---------- helpers ----------
const $ = (s,el=document)=>el.querySelector(s);
const $$ = (s,el=document)=>[...el.querySelectorAll(s)];
const esc = s => String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmtRun = r => `${Math.floor(r/60)}h ${String(r%60).padStart(2,'0')}m`;
const hash = s => { let h=2166136261; for(const c of s){ h^=c.charCodeAt(0); h=Math.imul(h,16777619);} return h>>>0; };
const listJoin = a => a.length<=1?(a[0]||''):a.slice(0,-1).join(', ')+' & '+a[a.length-1];
function seededRand(seed){ let s=seed>>>0||1; return ()=>{ s^=s<<13; s>>>=0; s^=s>>17; s^=s<<5; s>>>=0; return s/4294967296; }; }
function weightedPick(items, weightFn, rnd=Math.random){
  const w = items.map(weightFn); const tot = w.reduce((a,b)=>a+b,0);
  if(!items.length) return null;
  let x = rnd()*tot; for(let k=0;k<items.length;k++){ x-=w[k]; if(x<=0) return items[k]; }
  return items[items.length-1];
}
let toastT;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.classList.add('show'); clearTimeout(toastT); toastT=setTimeout(()=>t.classList.remove('show'),2200); }

// ---------- poster art (offline) + optional TMDB ----------
function posterHTML(m){
  const h = hash(m.t), h1 = h%360, h2=(h1+40+(h>>8)%80)%360;
  const url = store.posters[m.id];
  const glyph = GENRE_GLYPH[m.g[0]]||'🎬';
  const img = url ? `<img src="${esc(url)}" alt="${esc(m.t)} poster" loading="lazy" onerror="this.remove()">` : '';
  return `<div class="poster" data-poster="${m.id}" style="background:linear-gradient(160deg,hsl(${h1} 55% 32%),hsl(${h2} 60% 12%))">
    <div class="art"><span class="glyph">${glyph}</span><div class="ptitle">${esc(m.t)}</div><div class="pyear">${m.y}</div></div>${img}</div>`;
}
const tmdbQueue = new Set(); let tmdbActive=0; const tmdbTried=new Set();
function wantPoster(m){
  if(!store.tmdbKey || store.posters[m.id] || tmdbTried.has(m.id) || !navigator.onLine) return;
  tmdbQueue.add(m.id); pumpTmdb();
}
function pumpTmdb(){
  while(tmdbActive<4 && tmdbQueue.size){
    const id=[...tmdbQueue][0]; tmdbQueue.delete(id); tmdbTried.add(id); tmdbActive++;
    fetchPoster(BY_ID[id]).finally(()=>{tmdbActive--; pumpTmdb();});
  }
}
async function fetchPoster(m){
  const key = store.tmdbKey.trim();
  const bearer = key.startsWith('eyJ');
  const q = new URLSearchParams({query:m.t.replace(/·/g,''), year:m.y, include_adult:'false'});
  if(!bearer) q.set('api_key',key);
  try{
    const res = await fetch('https://api.themoviedb.org/3/search/movie?'+q, bearer?{headers:{Authorization:'Bearer '+key}}:{});
    if(!res.ok) { if(res.status===401) { toast('TMDB key rejected — check settings'); tmdbQueue.clear(); } return; }
    const j = await res.json(); const hit = (j.results||[]).find(r=>r.poster_path);
    if(hit){ store.posters[m.id]='https://image.tmdb.org/t/p/w342'+hit.poster_path; save();
      $$(`[data-poster="${m.id}"]`).forEach(el=>{ if(!el.querySelector('img')) el.insertAdjacentHTML('beforeend',`<img src="${store.posters[m.id]}" alt="" loading="lazy" onerror="this.remove()">`); });
    }
  }catch(e){}
}

// ---------- scoring ----------
/* crit: {moods:Set, genres:Set, runtime:Set, decades:Set, yFrom, yTo, minRating, services:Set, onlyMine, hideSeen, q,
          boostGenres:[], avoidGenres:[], prefer:'classic'|'gem', soft:true} */
function evaluate(m, c){
  const reasons=[]; let score=0;
  const soft = !!c.soft;
  // hard filters
  if(c.hideSeen && has('seen',m.id)) return null;
  if(c.q){ const q=c.q.toLowerCase(); if(!(m.t.toLowerCase().includes(q)||m.d.toLowerCase().includes(q)||m.g.join(' ').toLowerCase().includes(q))) return null; }
  if(c.avoidGenres && m.g.some(g=>c.avoidGenres.includes(g))) return null;
  if(c.requireGenres && !m.g.some(g=>c.requireGenres.includes(g))) return null;
  if(c.minRating && m.i < c.minRating) return null;
  if(c.yFrom && m.y < c.yFrom) return null;
  if(c.yTo && m.y > c.yTo) return null;

  const mine = c.services ? m.s.filter(s=>c.services.has(s)) : [];
  if(c.onlyMine && c.services && c.services.size && !mine.length) return null;

  if(c.runtime && c.runtime.size){
    const ok=[...c.runtime].some(k=>RUNTIMES[k].test(m.r));
    if(!ok){ if(!soft) return null; score-=2.5; }
    else { score+=1; reasons.push(m.r<90?`only ${m.r} mins — a nice short one`:m.r>120?`a proper ${fmtRun(m.r)} epic, as requested`:`a tidy ${fmtRun(m.r)}`); }
  }
  if(c.decades && c.decades.size){
    const ok=[...c.decades].some(k=>m.y>=DECADES[k][0]&&m.y<=DECADES[k][1]);
    if(!ok){ if(!soft) return null; score-=2; }
    else { score+=1; reasons.push(`from the ${DECADES[Object.keys(DECADES).find(k=>m.y>=DECADES[k][0]&&m.y<=DECADES[k][1])][2]}`); }
  }
  if(c.moods && c.moods.size){
    const hit=m.m.filter(x=>c.moods.has(x));
    if(!hit.length){ if(!soft) return null; score-=4; }
    else { score+=3*hit.length + (c.moods.has(m.m[0])?1.5:0); reasons.unshift(`nails the ${listJoin(hit.map(x=>MOODS[x].label.toLowerCase()))} vibe`); }
  }
  if(c.genres && c.genres.size){
    const hit=m.g.filter(x=>c.genres.has(x));
    if(!hit.length){ if(!soft) return null; score-=2; }
    else { score+=2*hit.length; reasons.push(`it's ${listJoin(hit)}`); }
  }
  if(c.boostGenres){
    const hit=m.g.filter(x=>c.boostGenres.includes(x));
    if(hit.length){ score+=1.5*hit.length; if(c.boostWhy) reasons.push(`${hit[0].toLowerCase()} works well ${c.boostWhy}`); }
  }
  if(mine.length){ score+=2; reasons.push(`it's on your ${listJoin(mine.map(s=>SERVICES[s].name))}`); }
  else if(c.services && c.services.size && soft){ score-=2.5; var warn = m.s.length ? `heads-up: it's on ${listJoin(m.s.map(s=>SERVICES[s].name))}, not your services` : 'heads-up: rent/buy only'; }

  // quality
  if(c.prefer==='gem'){ score += m.i<7.9 ? 1.5 : 0; if(m.i<7.9 && m.i>=7) reasons.push('a less-obvious pick that deserves more love'); }
  else { score += (m.i-7)*(c.prefer==='classic'?2:1.2); }
  if(m.i>=8.3) reasons.push(`rated a stellar ${m.i.toFixed(1)} on IMDb`);
  else if(m.i>=7.8) reasons.push(`well-loved at ${m.i.toFixed(1)} on IMDb`);
  if(has('watch',m.id)){ score+=1.5; reasons.push("it's already on your watchlist"); }
  return {m, score, reasons, warn: typeof warn!=='undefined'?warn:null};
}
function whySentence(ev){
  if(!ev || !ev.reasons.length) return `A strong all-rounder: ${ev?ev.m.i.toFixed(1):''} on IMDb and a crowd favourite.`;
  const r=[...new Set(ev.reasons)].slice(0,4);
  const s=r.join('; ');
  return s.charAt(0).toUpperCase()+s.slice(1)+'.'+(ev.warn?` (${ev.warn.charAt(0).toUpperCase()+ev.warn.slice(1)}.)`:'');
}

// ---------- shared rendering ----------
function badgesHTML(m, mineSet = new Set(store.services)){
  if(!m.s.length) return `<span class="badge none">Rent / buy</span>`;
  return m.s.map(s=>`<span class="badge ${mineSet.has(s)||!mineSet.size?'mine':''}" style="background:${SERVICES[s].color}" title="${SERVICES[s].name} (approx.)">${SERVICES[s].short}</span>`).join('');
}
function cardHTML(m, ev, {mini=false, showMatch=false, maxScore=1}={}){
  const pct = showMatch && ev ? Math.max(40,Math.min(99,Math.round(60+ (ev.score/Math.max(maxScore,1))*39))) : 0;
  return `<article class="card ${mini?'mini':''}" data-id="${m.id}">
    ${pct?`<span class="matchpill">${pct}% match</span>`:''}
    <div class="tools">
      <button class="tbtn fav ${has('fav',m.id)?'on':''}" data-act="fav" title="Favourite">♥</button>
      <button class="tbtn ${has('watch',m.id)?'on':''}" data-act="watch" title="Watchlist">📌</button>
    </div>
    <div data-open>${posterHTML(m)}</div>
    <div class="body">
      <h4 data-open>${esc(m.t)}</h4>
      <div class="meta"><span class="star">★ ${m.i.toFixed(1)}</span><span>${m.y}</span><span>${fmtRun(m.r)}</span></div>
      ${mini?'':`<div class="tags">${m.g.map(g=>`<span class="tag">${g}</span>`).join('')}</div>
      <p class="syn">${esc(m.d)}</p>
      ${ev&&ev.reasons.length?`<div class="reason">Why: ${esc(whySentence(ev))}</div>`:''}`}
      <div class="badges">${badgesHTML(m)}</div>
    </div></article>`;
}
function afterRender(root){ $$('[data-poster]',root).forEach(el=>{ const m=BY_ID[el.dataset.poster]; if(m) wantPoster(m); }); }

document.addEventListener('click', e=>{
  const act = e.target.closest('[data-act]');
  if(act){ const card=act.closest('[data-id]'); if(card){ e.stopPropagation(); toggleList(act.dataset.act, card.dataset.id); return; } }
  const open = e.target.closest('[data-open]');
  if(open){ const card=open.closest('[data-id]'); if(card) openDetail(card.dataset.id); }
  if(e.target.closest('[data-close]')) closeModal();
  const go = e.target.closest('[data-goto]'); if(go) switchView(go.dataset.goto);
});
document.addEventListener('keydown',e=>{ if(e.key==='Escape') { closeModal(); $('#filters').classList.remove('open'); } });

// ---------- modal / detail ----------
let lastContextCrit = null;
let lastFocus=null;
function openModal(html, detail=false){
  const wasHidden=$('#modal').hidden; if(wasHidden) lastFocus=document.activeElement;
  $('#modalBody').innerHTML=html; $('.modal-card').classList.toggle('is-detail',!!detail);
  $('#modal').classList.toggle('modal-detail',!!detail);
  $('#modal').hidden=false; document.body.style.overflow='hidden'; afterRender($('#modalBody'));
  if(wasHidden) requestAnimationFrame(()=>$('.modal-card .close').focus({preventScroll:true}));
}
function closeModal(){ if($('#modal').hidden) return; $('#modal').hidden=true; document.body.style.overflow='';
  if(lastFocus && lastFocus.focus) lastFocus.focus({preventScroll:true}); lastFocus=null; }
// focus trap inside dialog
document.addEventListener('keydown',e=>{
  if(e.key!=='Tab' || $('#modal').hidden) return;
  const f=$$('.modal-card button, .modal-card a[href], .modal-card input').filter(x=>x.offsetParent);
  if(!f.length) return; const first=f[0], last=f[f.length-1];
  if(e.shiftKey && document.activeElement===first){ e.preventDefault(); last.focus(); }
  else if(!e.shiftKey && document.activeElement===last){ e.preventDefault(); first.focus(); }
});

// palette derived from title — used for the generated cinematic backdrop
function palette(m){
  const h=hash(m.t), h1=h%360, h2=(h1+40+(h>>8)%80)%360, h3=(h1+180+(h>>16)%60)%360;
  return {h1,h2,h3,
    bg:`radial-gradient(120% 90% at 85% 10%,hsl(${h1} 70% 38% / .95),transparent 60%),
        radial-gradient(90% 80% at 10% 90%,hsl(${h2} 65% 30% / .9),transparent 65%),
        radial-gradient(60% 60% at 60% 70%,hsl(${h3} 55% 22% / .7),transparent 70%),
        linear-gradient(160deg,hsl(${h1} 45% 14%),hsl(${h2} 50% 6%))`,
    accent:`hsl(${h1} 85% 72%)`};
}
// ---- optional TMDB enrichment: backdrop, director, cast, trailer (cached) ----
const extraTried=new Set();
async function fetchExtra(m){
  const key=(store.tmdbKey||'').trim(); if(!key || !navigator.onLine || extraTried.has(m.id)) return;
  if(store.extra && store.extra[m.id]) return;
  extraTried.add(m.id);
  const bearer=key.startsWith('eyJ'); const opt=bearer?{headers:{Authorization:'Bearer '+key}}:{};
  const k=bearer?'':'&api_key='+encodeURIComponent(key);
  try{
    const sr=await fetch('https://api.themoviedb.org/3/search/movie?query='+encodeURIComponent(m.t.replace(/·/g,''))+'&year='+m.y+k,opt);
    if(!sr.ok) return; const hit=((await sr.json()).results||[])[0]; if(!hit) return;
    const dr=await fetch(`https://api.themoviedb.org/3/movie/${hit.id}?append_to_response=credits,videos${k}`,opt);
    if(!dr.ok) return; const d=await dr.json();
    const vid=(d.videos?.results||[]).find(v=>v.site==='YouTube'&&v.type==='Trailer');
    store.extra=store.extra||{};
    store.extra[m.id]={
      backdrop:d.backdrop_path?'https://image.tmdb.org/t/p/w1280'+d.backdrop_path:'',
      tagline:d.tagline||'',
      director:(d.credits?.crew||[]).filter(c=>c.job==='Director').map(c=>c.name).slice(0,2),
      cast:(d.credits?.cast||[]).slice(0,8).map(c=>({n:c.name,c:c.character,p:c.profile_path?'https://image.tmdb.org/t/p/w185'+c.profile_path:''})),
      trailer:vid?'https://www.youtube.com/watch?v='+vid.key:''};
    save();
    if(!$('#modal').hidden && modalState && modalState.m.id===m.id){ const st=$('.modal-card').scrollTop; const {ev,title,again}=modalState; showDetail(m,ev,title,again,true); $('.modal-card').scrollTop=st; }
  }catch(e){}
}
const initials=n=>n.split(/\s+/).map(w=>w[0]).slice(0,2).join('');
const ICON={
  play:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  plus:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>',
  check:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  heart:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20s-7-4.4-9.2-9C1.4 7.9 3.4 4.5 6.8 4.5c2 0 3.4 1.1 4.2 2.4h2c.8-1.3 2.2-2.4 4.2-2.4 3.4 0 5.4 3.4 4 6.5C19 15.6 12 20 12 20z" fill="currentColor"/></svg>',
  dice:'<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="3.5" width="17" height="17" rx="4" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor"/><circle cx="15.5" cy="15.5" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/></svg>',
  eye:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" stroke="currentColor" stroke-width="2" fill="none"/><circle cx="12" cy="12" r="3" fill="currentColor"/></svg>',
  ext:'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>',
};
function detailHTML(m, ev, {title='', again=false}={}){
  ev = ev || evaluate(m, Object.assign({}, lastContextCrit||{}, {services:new Set(store.services), hideSeen:false, soft:true, onlyMine:false})) || {m,reasons:[],score:0};
  const x=(store.extra||{})[m.id]||{}; const pal=palette(m);
  const q=encodeURIComponent(m.t+' '+m.y);
  const onW=has('watch',m.id), onF=has('fav',m.id), onS=has('seen',m.id);
  const trailer=x.trailer||`https://www.youtube.com/results?search_query=${q}+trailer`;
  const mine=new Set(store.services);
  const svc = m.s.length ? m.s.map(s=>{const v=SERVICES[s]; const own=mine.has(s);
      return `<li class="dv-svc ${own?'own':''}" style="--svc:${v.color}"><span class="dv-svc-dot"></span><span><b>${v.name}</b><small>${own?'In your services':'Subscription'}</small></span>${own?ICON.check:''}</li>`;}).join('')
    : `<li class="dv-svc"><span class="dv-svc-dot" style="--svc:#666"></span><span><b>Rent or buy</b><small>Not on major UK subscriptions</small></span></li>`;
  const castBlock = x.cast && x.cast.length ? `<section class="dv-sec dv-cast-sec"><h4>Cast</h4><ul class="dv-cast">${x.cast.map(c=>`<li><span class="dv-av">${c.p?`<img src="${esc(c.p)}" alt="" loading="lazy" onerror="this.remove()">`:''}<i>${esc(initials(c.n))}</i></span><b>${esc(c.n)}</b><small>${esc(c.c||'')}</small></li>`).join('')}</ul></section>` : '';
  const crew = x.director && x.director.length ? `<div class="dv-credit"><span>Directed by</span><b>${esc(listJoin(x.director))}</b></div>` : '';
  return `<article class="dv" data-id="${m.id}" style="--acc:${pal.accent};--h1:${pal.h1};--h2:${pal.h2}" aria-labelledby="dvTitle">
    <div class="dv-hero">
      <div class="dv-backdrop" style="background:${pal.bg}">${x.backdrop?`<img src="${esc(x.backdrop)}" alt="" onerror="this.remove()">`:`<span class="dv-bigtitle" aria-hidden="true">${esc(m.t)}</span>`}<span class="dv-grain"></span></div>
      <div class="dv-shade"></div>
      <div class="dv-head">
        <div class="dv-poster">${posterHTML(m)}</div>
        <div class="dv-titles">
          ${title?`<div class="dv-eyebrow">${title}</div>`:''}
          <h2 id="dvTitle">${esc(m.t)}</h2>
          ${x.tagline?`<p class="dv-tagline">${esc(x.tagline)}</p>`:''}
          <ul class="dv-chips" aria-label="Film details">
            <li class="dv-chip dv-rating" title="IMDb rating"><span class="dv-star">★</span> ${m.i.toFixed(1)}<small>IMDb</small></li>
            <li class="dv-chip">${m.y}</li>
            <li class="dv-chip">${fmtRun(m.r)}</li>
            ${m.g.map(g=>`<li class="dv-chip dv-genre">${esc(g)}</li>`).join('')}
          </ul>
          <div class="dv-actions">
            <a class="dv-btn dv-primary" target="_blank" rel="noopener" href="${esc(trailer)}">${ICON.play}<span>Watch trailer</span></a>
            <button class="dv-btn ${onW?'on':''}" data-act="watch" aria-pressed="${onW}">${onW?ICON.check:ICON.plus}<span>${onW?'On watchlist':'Watchlist'}</span></button>
            ${again?`<button class="dv-btn dv-again" id="againBtn">${ICON.dice}<span>Pick another</span></button>`:''}
            <button class="dv-icon ${onF?'on fav':''}" data-act="fav" aria-pressed="${onF}" aria-label="${onF?'Remove from favourites':'Add to favourites'}" title="Favourite">${ICON.heart}</button>
            <button class="dv-icon ${onS?'on':''}" data-act="seen" aria-pressed="${onS}" aria-label="${onS?'Unmark as seen':'Mark as seen'}" title="${onS?'Seen':'Mark seen'}">${ICON.eye}</button>
          </div>
        </div>
      </div>
    </div>
    <div class="dv-body">
      <div class="dv-main">
        <p class="dv-syn">${esc(m.d)}</p>
        ${crew}
        <div class="dv-moods" aria-label="Mood">${m.m.map(k=>`<span class="dv-mood"><span aria-hidden="true">${MOODS[k].e}</span>${MOODS[k].label}<small>${MOODS[k].s}</small></span>`).join('')}</div>
        <div class="dv-why"><span class="dv-why-k">Why this one</span><p>${esc(whySentence(ev))}</p></div>
        ${castBlock}
      </div>
      <aside class="dv-side">
        <section class="dv-sec dv-glass"><h4>Where to watch <small>UK · approx.</small></h4><ul class="dv-svcs">${svc}</ul>
          <a class="dv-link" target="_blank" rel="noopener" href="https://www.justwatch.com/uk/search?q=${encodeURIComponent(m.t)}">Check live availability ${ICON.ext}</a></section>
        <section class="dv-sec dv-glass dv-more"><h4>More</h4>
          <a class="dv-link" target="_blank" rel="noopener" href="https://www.imdb.com/find/?q=${q}">IMDb ${ICON.ext}</a>
          <a class="dv-link" target="_blank" rel="noopener" href="https://letterboxd.com/search/${encodeURIComponent(m.t)}/">Letterboxd ${ICON.ext}</a>
          ${!x.cast?`<a class="dv-link" target="_blank" rel="noopener" href="https://www.themoviedb.org/search?query=${encodeURIComponent(m.t)}">Cast &amp; crew on TMDB ${ICON.ext}</a>`:''}
        </section>
      </aside>
    </div>
  </article>`;
}
let modalState = null;
function showDetail(m, ev=null, title='', again=null, noAnim=false){
  modalState={m,ev,title,again};
  openModal(detailHTML(m, ev, {title, again:!!again}), true);
  if(noAnim) $('.dv').classList.add('no-anim');
  if(again) $('#againBtn').onclick=again;
  fetchExtra(m);
}
function openDetail(id){ showDetail(BY_ID[id]); }

// ---------- surprise ----------
function surprise(pool, label='Surprise pick', crit=null){
  if(!pool.length){ toast('Nothing matches — loosen a filter or two'); return; }
  if(crit) lastContextCrit=crit;
  const minS = Math.min(...pool.map(e=>e.score));
  const cur = modalState && !$('#modal').hidden ? modalState.m.id : null;
  const cand = pool.length>1 ? pool.filter(e=>e.m.id!==cur) : pool;
  const pick = weightedPick(cand, e=>Math.pow(e.score-minS+1,1.6)*Math.max(.5,e.m.i-5.5));
  showDetail(pick.m, pick, `🎲 ${label} · from ${pool.length} match${pool.length>1?'es':''}`, ()=>surprise(pool,label,crit));
  $('#modalBody .dv').classList.add('rerolled');
}

// ---------- TONIGHT ----------
let heroPick=null;
function tonightPool(){
  const crit={services:new Set(store.services), hideSeen:true, soft:true, minRating:7.3};
  const dow=new Date().getDay(); // weekend: anything; weeknight: prefer <=2h
  if(dow>=1 && dow<=4) crit.runtime=new Set(['short','mid']);
  return MOVIES.map(m=>evaluate(m,crit)).filter(Boolean);
}
function renderHero(reroll=false){
  const pool=tonightPool(); if(!pool.length){ $('#hero').innerHTML=''; return; }
  const today=new Date().toISOString().slice(0,10);
  const rnd = reroll?Math.random:seededRand(hash(today+store.services.join('')));
  if(!heroPick || reroll || !pool.find(e=>e.m.id===heroPick.m.id)){
    const minS=Math.min(...pool.map(e=>e.score));
    heroPick = weightedPick(pool, e=>Math.pow(e.score-minS+1,2), rnd);
  } else heroPick = pool.find(e=>e.m.id===heroPick.m.id);
  const ev=heroPick, m=ev.m;
  const day=new Date().toLocaleDateString('en-GB',{weekday:'long'});
  const dayWhy = (new Date().getDay()>=1&&new Date().getDay()<=4) ? `It's a ${day}, so we kept it under two hours` : `It's ${day} — perfect excuse for a proper film night`;
  const h=hash(m.t)%360;
  $('#hero').innerHTML=`<div class="hero-bg" style="background:radial-gradient(circle at 30% 40%,hsl(${h} 70% 40%),transparent 60%),radial-gradient(circle at 80% 70%,hsl(${(h+60)%360} 70% 30%),transparent 60%)"></div>
    <div data-id="${m.id}"><div data-open>${posterHTML(m)}</div></div>
    <div data-id="${m.id}">
      <span class="eyebrow">✦ Tonight's pick · ${day}</span>
      <h1>${esc(m.t)}</h1>
      <div class="meta"><span class="star">★ ${m.i.toFixed(1)}</span><span>${m.y}</span><span>${fmtRun(m.r)}</span><span>${m.g.join(' · ')}</span></div>
      <p class="syn">${esc(m.d)}</p>
      <div class="why"><b>Why this one?</b> ${esc(dayWhy)}. ${esc(whySentence(ev))}</div>
      <div class="badges">${badgesHTML(m)}</div>
      <div class="actions">
        <button class="btn gold" data-open>▶ Details</button>
        <button class="btn ${has('watch',m.id)?'gold':''}" data-act="watch">📌 ${has('watch',m.id)?'On watchlist':'Watchlist'}</button>
        <button class="btn" id="rerollHero">↻ Not feeling it</button>
        <button class="btn ghost" data-goto="quiz">Take the quiz</button>
      </div>
    </div>`;
  $('#rerollHero').onclick=()=>renderHero(true);
  afterRender($('#hero'));
}
function renderQuickMoods(){
  $('#quickMoods').innerHTML=Object.entries(MOODS).map(([k,v])=>`<button class="mood" data-mood="${k}"><span class="e">${v.e}</span><span class="l">${v.label}</span><br><span class="s">${v.s}</span></button>`).join('')
    + `<button class="mood" data-mood="*"><span class="e">🎲</span><span class="l">Anything!</span><br><span class="s">Total wildcard</span></button>`;
  $$('#quickMoods .mood').forEach(b=>b.onclick=()=>{
    const k=b.dataset.mood;
    const crit={moods:k==='*'?null:new Set([k]), services:new Set(store.services), hideSeen:true, soft:false};
    let pool=MOVIES.map(m=>evaluate(m,crit)).filter(Boolean);
    if(store.services.length){ const onMine=pool.filter(e=>e.m.s.some(s=>store.services.includes(s))); if(onMine.length>=3) pool=onMine; }
    surprise(pool, k==='*'?'Wildcard':MOODS[k].label, crit);
  });
}
function renderTonightRow(){
  const crit={services:new Set(store.services), hideSeen:true, soft:true};
  const list=MOVIES.map(m=>evaluate(m,crit)).filter(Boolean)
    .filter(e=>!store.services.length || e.m.s.some(s=>store.services.includes(s)))
    .sort((a,b)=>b.m.i-a.m.i).slice(0,16);
  $('#tonightRow').innerHTML=list.map(e=>cardHTML(e.m,e,{mini:true})).join('') || '<p class="muted">Nothing here yet.</p>';
  $('#tonightRow').previousElementSibling.querySelector('h2').textContent = store.services.length?'Top-rated on your services':'Top-rated all-timers';
  afterRender($('#tonightRow'));
}

// ---------- BROWSE ----------
const F = { moods:new Set(), genres:new Set(), runtime:new Set(), decades:new Set(), yFrom:null, yTo:null, minRating:0,
            services:new Set(store.services), onlyMine:false, hideSeen:true, q:'', sort:'match' };
function chipSet(el, entries, set, onChange, cls=''){
  el.innerHTML = entries.map(([k,label,style])=>`<button class="chip ${cls} ${set.has(k)?'on':''}" data-k="${esc(k)}" ${style&&set.has(k)?`style="${style}"`:''} data-style="${style||''}">${label}</button>`).join('');
  $$('.chip',el).forEach(b=>b.onclick=()=>{ const k=b.dataset.k; set.has(k)?set.delete(k):set.add(k); b.classList.toggle('on'); b.style.cssText=set.has(k)&&b.dataset.style?b.dataset.style:''; onChange(); });
}
function buildFilters(){
  chipSet($('#fMood'), Object.entries(MOODS).map(([k,v])=>[k,`${v.e} ${v.label}`]), F.moods, renderBrowse);
  chipSet($('#fGenre'), ALL_GENRES.map(g=>[g,`${GENRE_GLYPH[g]||''} ${g}`]), F.genres, renderBrowse);
  chipSet($('#fRuntime'), Object.entries(RUNTIMES).map(([k,v])=>[k,v.label]), F.runtime, renderBrowse);
  chipSet($('#fDecade'), Object.entries(DECADES).map(([k,v])=>[k,v[2]]), F.decades, renderBrowse);
  chipSet($('#fServices'), Object.entries(SERVICES).map(([k,v])=>[k,v.name,`background:${v.color};border-color:${v.color}`]), F.services, ()=>{
    store.services=[...F.services]; save(); renderBrowse(); renderTonightRow(); renderHero(); }, 'svc');
  $('#q').value=F.q; $('#minRating').value=F.minRating||6; $('#ratingOut').textContent=F.minRating?F.minRating.toFixed(1)+'+':'any';
  $('#yFrom').value=F.yFrom||''; $('#yTo').value=F.yTo||''; $('#onlyMine').checked=F.onlyMine; $('#hideSeen').checked=F.hideSeen; $('#sort').value=F.sort;
}
function wireFilters(){
  $('#q').oninput=e=>{F.q=e.target.value.trim(); renderBrowse();};
  $('#minRating').oninput=e=>{ const v=+e.target.value; F.minRating=v<=6?0:v; $('#ratingOut').textContent=F.minRating?v.toFixed(1)+'+':'any'; renderBrowse(); };
  $('#yFrom').oninput=e=>{F.yFrom=+e.target.value||null; renderBrowse();};
  $('#yTo').oninput=e=>{F.yTo=+e.target.value||null; renderBrowse();};
  $('#onlyMine').onchange=e=>{F.onlyMine=e.target.checked; renderBrowse();};
  $('#hideSeen').onchange=e=>{F.hideSeen=e.target.checked; renderBrowse();};
  $('#sort').onchange=e=>{F.sort=e.target.value; renderBrowse();};
  $('#resetFilters').onclick=()=>{ ['moods','genres','runtime','decades'].forEach(k=>F[k].clear()); Object.assign(F,{yFrom:null,yTo:null,minRating:0,onlyMine:false,q:'',sort:'match'}); buildFilters(); renderBrowse(); };
  $('#toggleFilters').onclick=()=>$('#filters').classList.toggle('open');
  $('#closeFilters').onclick=()=>$('#filters').classList.remove('open');
  $('#surpriseBtn').onclick=()=>surprise(browseResults(),'Surprise me',browseCrit());
}
const browseCrit = () => ({...F, soft:false});
function browseResults(){ const c=browseCrit(); return MOVIES.map(m=>evaluate(m,c)).filter(Boolean); }
function renderBrowse(){
  const res=browseResults();
  const sorters={match:(a,b)=>b.score-a.score||b.m.i-a.m.i, rating:(a,b)=>b.m.i-a.m.i, new:(a,b)=>b.m.y-a.m.y, old:(a,b)=>a.m.y-b.m.y, short:(a,b)=>a.m.r-b.m.r, az:(a,b)=>a.m.t.localeCompare(b.m.t)};
  res.sort(sorters[F.sort]);
  const maxScore=Math.max(1,...res.map(e=>e.score));
  const filtering = F.moods.size||F.genres.size||F.runtime.size||F.decades.size||F.q;
  $('#resultCount').textContent=`${res.length} film${res.length===1?'':'s'}`;
  $('#results').innerHTML = res.length ? res.map(e=>cardHTML(e.m,e,{showMatch:filtering,maxScore})).join('')
    : `<div class="empty"><span class="e">🍿</span>No films match all of that.<br>Try removing a filter — or hit Reset.</div>`;
  // active chips
  const act=[];
  F.moods.forEach(k=>act.push(['moods',k,MOODS[k].label])); F.genres.forEach(k=>act.push(['genres',k,k]));
  F.runtime.forEach(k=>act.push(['runtime',k,RUNTIMES[k].label])); F.decades.forEach(k=>act.push(['decades',k,DECADES[k][2]]));
  if(F.minRating) act.push(['minRating',null,`★ ${F.minRating.toFixed(1)}+`]);
  if(F.onlyMine && F.services.size) act.push(['onlyMine',null,`On ${[...F.services].map(s=>SERVICES[s].name).join('/')}`]);
  $('#activeChips').innerHTML=act.map(([g,k,l],i)=>`<button class="chip on" data-i="${i}">${esc(l)} ✕</button>`).join('');
  $$('#activeChips .chip').forEach(b=>b.onclick=()=>{ const [g,k]=act[+b.dataset.i]; if(k!==null) F[g].delete(k); else if(g==='minRating') F.minRating=0; else F[g]=false; buildFilters(); renderBrowse(); });
  lastContextCrit = browseCrit();
  afterRender($('#results'));
}

// ---------- QUIZ ----------
const QUIZ = [
  {k:'mood', q:"What's the vibe tonight?", opts:[...Object.entries(MOODS).map(([k,v])=>({v:k,e:v.e,l:v.label,s:v.s})),{v:'*',e:'🤷',l:'No idea',s:'Surprise me'}]},
  {k:'who', q:"Who's watching?", opts:[{v:'solo',e:'🧍',l:'Just me',s:'My pick, my rules'},{v:'date',e:'🥂',l:'Date night',s:'Something for two'},{v:'family',e:'👨‍👩‍👧',l:'Family / kids',s:'Nothing too dark'},{v:'friends',e:'🍕',l:'Mates',s:'Crowd-pleaser'}]},
  {k:'time', q:'How much time have you got?', opts:[{v:'short',e:'⏱️',l:'Under 90 mins',s:'Quick one'},{v:'mid',e:'🕰️',l:'Up to 2 hours',s:'Standard film'},{v:'long',e:'🌙',l:'All night',s:'Bring on the epic'},{v:'*',e:'♾️',l:"Doesn't matter",s:''}]},
  {k:'era', q:'Old or new?', opts:[{v:'classic',e:'📼',l:'Classics',s:'Before 2000'},{v:'mid',e:'💿',l:'2000s–2010s',s:'Modern-ish'},{v:'new',e:'✨',l:'Recent',s:'2018 onwards'},{v:'*',e:'🎞️',l:'Any era',s:''}]},
  {k:'svc', multi:true, q:'Which services have you got?', note:'Pick all that apply — we remember for next time.', opts:[...Object.entries(SERVICES).map(([k,v])=>({v:k,e:'📺',l:v.name})),{v:'*',e:'💷',l:"Don't mind",s:'Happy to rent'}]},
  {k:'taste', q:'Last one: safe bet or something different?', opts:[{v:'classic',e:'🏆',l:'Safe bet',s:'Highly rated, proven'},{v:'gem',e:'💎',l:'Something different',s:'Less obvious picks'},{v:'*',e:'⚖️',l:'Either',s:''}]},
];
let qi=0; const qa={};
function renderQuiz(){
  const el=$('#quiz');
  if(qi>=QUIZ.length) return renderQuizResults();
  const step=QUIZ[qi];
  if(step.multi && !qa[step.k]) qa[step.k]=new Set(store.services);
  const isOn=v=> step.multi ? qa[step.k].has(v) : qa[step.k]===v;
  el.innerHTML=`<div class="progress"><i style="width:${qi/QUIZ.length*100}%"></i></div>
    <div class="qstep">Question ${qi+1} of ${QUIZ.length}</div><h2>${step.q}</h2>${step.note?`<p class="muted" style="margin-top:-10px">${step.note}</p>`:''}
    <div class="opts">${step.opts.map(o=>`<button class="opt ${isOn(o.v)?'on':''}" data-v="${o.v}"><span class="e">${o.e}</span><span><b>${o.l}</b>${o.s?`<span class="s">${o.s}</span>`:''}</span></button>`).join('')}</div>
    <div class="qnav"><button class="btn ghost" id="qBack" ${qi===0?'style="visibility:hidden"':''}>← Back</button>
    ${step.multi?`<button class="btn gold" id="qNext">Next →</button>`:''}</div>`;
  $$('.opt',el).forEach(b=>b.onclick=()=>{
    const v=b.dataset.v;
    if(step.multi){ const s=qa[step.k]; if(v==='*'){ s.clear(); } else { s.has(v)?s.delete(v):s.add(v); } renderQuiz(); }
    else { qa[step.k]=v; qi++; renderQuiz(); }
  });
  $('#qBack').onclick=()=>{ qi=Math.max(0,qi-1); renderQuiz(); };
  if(step.multi) $('#qNext').onclick=()=>{ store.services=[...qa.svc]; F.services=new Set(store.services); save(); buildFilters(); renderTonightRow(); renderHero(); qi++; renderQuiz(); };
}
function quizCrit(){
  const c={soft:true, hideSeen:true, services:qa.svc||new Set(), prefer:qa.taste==='*'?null:qa.taste};
  if(qa.mood && qa.mood!=='*') c.moods=new Set([qa.mood]);
  if(qa.time && qa.time!=='*') c.runtime=new Set(qa.time==='mid'?['short','mid']:[qa.time]);
  if(qa.era==='classic') c.decades=new Set(['70s','80s','90s']);
  if(qa.era==='mid') c.decades=new Set(['00s','10s']);
  if(qa.era==='new') c.yFrom=2018;
  if(qa.who==='family'){ c.avoidGenres=['Horror','Crime','War']; c.requireGenres=['Family','Animation','Comedy','Adventure','Musical','Fantasy']; c.boostGenres=['Family','Animation']; c.boostWhy='for all ages'; }
  if(qa.who==='date'){ c.boostGenres=['Romance','Comedy']; c.boostWhy='for a date night'; c.avoidGenres=['Horror'].filter(()=>qa.mood!=='th'); }
  if(qa.who==='friends'){ c.boostGenres=['Comedy','Action','Horror']; c.boostWhy='with a group'; }
  if(qa.mood==='*' && !c.prefer) c.prefer='classic';
  return c;
}
let quizPicks=[];
function computeQuizPicks(){
  const c=quizCrit(); lastContextCrit=c;
  let pool=MOVIES.map(m=>evaluate(m,c)).filter(Boolean).sort((a,b)=>b.score-a.score);
  if(pool.length && c.yFrom){ /* already hard */ }
  const top=pool.slice(0,14); const picks=[];
  const minS=top.length?Math.min(...top.map(e=>e.score)):0;
  while(picks.length<3 && top.length){ const p=weightedPick(top,e=>Math.pow(e.score-minS+1,2)); picks.push(p); top.splice(top.indexOf(p),1); }
  picks.sort((a,b)=>b.score-a.score);
  quizPicks=picks;
}
function renderQuizResults(){
  if(!quizPicks.length) computeQuizPicks();
  const el=$('#quiz');
  el.innerHTML=`<div class="progress"><i style="width:100%"></i></div><div class="qstep">Your picks</div><h2>Here's what we reckon 🍿</h2>
    <div class="quiz-results">${quizPicks.length?quizPicks.map((e,i)=>`<div class="pick ${i===0?'first':''}" data-id="${e.m.id}">
      <div data-open>${posterHTML(e.m)}</div>
      <div><span class="eyebrow">${i===0?'★ Top pick':'Also great'}</span><h3 data-open style="cursor:pointer">${esc(e.m.t)}</h3>
      <div class="meta"><span class="star">★ ${e.m.i.toFixed(1)}</span><span>${e.m.y}</span><span>${fmtRun(e.m.r)}</span><span>${e.m.g.join(' · ')}</span></div>
      <p>${esc(e.m.d)}</p><div class="why"><b>Why this one?</b> ${esc(whySentence(e))}</div>
      <div class="badges">${badgesHTML(e.m, qa.svc)}</div>
      <div class="actions"><button class="btn small ${has('watch',e.m.id)?'gold':''}" data-act="watch">📌 ${has('watch',e.m.id)?'On watchlist':'Watchlist'}</button><button class="btn small" data-act="fav">${has('fav',e.m.id)?'♥':'♡'} Favourite</button><button class="btn small ghost" data-act="seen">Seen it</button></div>
      </div></div>`).join(''):'<div class="empty"><span class="e">🤔</span>Nothing fits every answer — try loosening one.</div>'}</div>
    <div class="qnav"><button class="btn ghost" id="qRestart">↺ Start over</button><button class="btn gold" id="qShuffle">🎲 Shuffle picks</button></div>`;
  $('#qRestart').onclick=()=>{ qi=0; for(const k in qa) delete qa[k]; quizPicks=[]; renderQuiz(); };
  $('#qShuffle').onclick=()=>{ computeQuizPicks(); renderQuizResults(); };
  afterRender(el);
}

// ---------- SAVED ----------
let savedList='watch';
function renderSaved(){
  const ids=store[savedList].filter(id=>BY_ID[id]);
  const labels={watch:'watchlist',fav:'favourites',seen:'seen list'};
  $('#savedInfo').textContent=`${ids.length} film${ids.length===1?'':'s'} in your ${labels[savedList]}`;
  $('#savedGrid').innerHTML=ids.length?ids.slice().reverse().map(id=>cardHTML(BY_ID[id],null)).join(''):
    `<div class="empty"><span class="e">${savedList==='fav'?'♡':savedList==='seen'?'✓':'📌'}</span>Nothing here yet. Tap ${savedList==='fav'?'♥':savedList==='seen'?'“Mark seen”':'📌'} on any film to add it.</div>`;
  $('#savedSurprise').style.display = savedList==='seen'||!ids.length ? 'none':'';
  afterRender($('#savedGrid'));
}
$$('.saved-tabs .chip').forEach(b=>b.onclick=()=>{ $$('.saved-tabs .chip').forEach(x=>x.classList.remove('on')); b.classList.add('on'); savedList=b.dataset.list; renderSaved(); });
$('#savedSurprise').onclick=()=>{ const c={services:new Set(store.services),soft:true}; surprise(store[savedList].filter(id=>BY_ID[id] && !(savedList==='watch'&&has('seen',id))).map(id=>evaluate(BY_ID[id],c)).filter(Boolean),'From your '+(savedList==='fav'?'favourites':'watchlist'),c); };
function updateSavedCount(){ const n=store.watch.length; $('#savedCount').textContent=n||''; }

// ---------- settings ----------
$('#settingsBtn').onclick=()=>{
  modalState=null;
  openModal(`<div class="settings"><h2>Settings</h2>
    <label>My streaming services</label><div class="chips" id="setSvc"></div>
    <label for="tmdbKey">TMDB API key (optional — real posters)</label>
    <input type="text" id="tmdbKey" placeholder="v3 API key or v4 read token" value="${esc(store.tmdbKey)}">
    <p class="tiny muted">TMDB needs a free personal key (themoviedb.org → Settings → API). Without one, the app uses generated poster art and works 100% offline. Posters are cached once fetched.</p>
    <div class="actions"><button class="btn gold" id="saveKey">Save</button><button class="btn ghost" id="clearPosters">Clear poster cache</button>
    <button class="btn ghost" id="exportData">Export my lists</button><button class="btn ghost" id="wipe" style="color:var(--red)">Reset everything</button></div>
    <p class="tiny muted" style="margin-top:18px">This product uses the TMDB API (when a key is supplied) but is not endorsed or certified by TMDB. Streaming availability is a hand-curated UK snapshot and will drift — always confirm via “Check where to watch”.</p></div>`);
  const svcSet=new Set(store.services);
  chipSet($('#setSvc'), Object.entries(SERVICES).map(([k,v])=>[k,v.name,`background:${v.color};border-color:${v.color}`]), svcSet, ()=>{ store.services=[...svcSet]; F.services=new Set(svcSet); save(); buildFilters(); refreshAll(); }, 'svc');
  $('#saveKey').onclick=()=>{ store.tmdbKey=$('#tmdbKey').value.trim(); tmdbTried.clear(); save(); toast(store.tmdbKey?'Key saved — fetching posters…':'Key removed'); closeModal(); refreshAll(); };
  $('#clearPosters').onclick=()=>{ store.posters={}; store.extra={}; tmdbTried.clear(); extraTried.clear(); save(); toast('Poster cache cleared'); refreshAll(); };
  $('#exportData').onclick=()=>{ const out={watchlist:store.watch.map(id=>BY_ID[id]?.t),favourites:store.fav.map(id=>BY_ID[id]?.t),seen:store.seen.map(id=>BY_ID[id]?.t)};
    const a=document.createElement('a'); a.href=URL.createObjectURL(new Blob([JSON.stringify(out,null,2)],{type:'application/json'})); a.download='reelpick-lists.json'; a.click(); };
  $('#wipe').onclick=()=>{ if(confirm('Clear watchlist, favourites, seen list and settings?')){ localStorage.removeItem(LS_KEY); location.reload(); } };
};

// ---------- view switching ----------
function switchView(v){
  $$('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===v));
  $$('.view').forEach(s=>s.classList.toggle('active',s.id==='view-'+v));
  if(v==='saved') renderSaved();
  if(v==='quiz') renderQuiz();
  if(v==='browse') renderBrowse();
  history.replaceState(null,'','#'+v);
  window.scrollTo({top:0,behavior:'smooth'});
}
$$('.tab').forEach(t=>t.onclick=()=>switchView(t.dataset.view));

function refreshAll(){
  const active=$('.view.active').id.replace('view-','');
  if(active==='browse') renderBrowse();
  if(active==='saved') renderSaved();
  if(active==='quiz' && qi>=QUIZ.length) renderQuizResults();
  renderTonightRow(); renderHero();
  if(!$('#modal').hidden && modalState){ const st=$('.modal-card').scrollTop; const {m,title,again}=modalState;
    const ev = modalState.ev ? evaluate(m, Object.assign({}, lastContextCrit||{}, {hideSeen:false})) || modalState.ev : null;
    showDetail(m, ev, title, again, true); $('.modal-card').scrollTop=st; }
}

// ---------- init ----------
$('#nFilms').textContent=MOVIES.length;
buildFilters(); wireFilters(); renderQuickMoods(); renderHero(); renderTonightRow(); updateSavedCount();
const start=(location.hash||'').slice(1);
if(['tonight','quiz','browse','saved'].includes(start)) switchView(start);
window.ReelPick={MOVIES,evaluate,store}; // for debugging
})();
