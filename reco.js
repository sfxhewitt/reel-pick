/* Reel Pick recommender (client-side, no build step). Pure functions; UMD so tests can run them in Node.
   Methods:
   - Affect space: Russell's circumplex (valence x arousal) plus viewing-experience dimensions scored at build time.
   - Mood management (Zillmann 1988): "match my mood" sustains the current state; "change my mood" targets repair
     (stressed -> calming & pleasant, low -> uplifting, bored -> stimulating ...).
   - Content-based similarity: cosine over the centred affect vector + cosine over genre/keyword TF-IDF.
   - Bayesian average (IMDb weighted rating): WR = v/(v+m)·R + m/(v+m)·C.
   - MMR (Carbonell & Goldstein 1998) for diverse result lists.
   - Rocchio relevance feedback: profile = β·mean(liked) − γ·mean(disliked/skipped).
   - Explanations built from the actual terms that drove the score. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Reco = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const DIMS = ['valence','arousal','dark','humour','complex','pace','weight','comfort','violence','scary','sex','family','romance'];
  const AFFECT = ['V','A','dark','humour','complex','pace','weight','comfort'];

  /* ---- affect vector ---- */
  function circumplex(d, q){
    // two estimates of valence/arousal: direct nouls and the quadrant distribution
    const qv = q ? (q.excited + q.content) : d.valence, qa = q ? (q.excited + q.tense) : d.arousal;
    return { V: (d.valence + qv) / 2, A: (d.arousal + qa) / 2 };
  }
  function affectVec(f){ return AFFECT.map(k => (f.dims[k] ?? 0.5) - 0.5); }
  function cosDense(a, b){ let s=0, na=0, nb=0; for (let i=0;i<a.length;i++){ s+=a[i]*b[i]; na+=a[i]*a[i]; nb+=b[i]*b[i]; } return na&&nb ? s/Math.sqrt(na*nb) : 0; }
  function cosSparse(a, b){ if (!a || !b) return 0; let s=0; const [x,y] = a.size < b.size ? [a,b] : [b,a]; for (const [k,v] of x){ const w = y.get(k); if (w) s += v*w; } return s; } // both unit-normalised

  /* ---- TF-IDF over genres + keywords ---- */
  function buildTfidf(films){
    const df = new Map(); const N = films.length || 1;
    const toks = f => [...(f.g||[]).map(g=>'g:'+g), ...(f.kw||[]).map(k=>'k:'+k)];
    for (const f of films) for (const t of new Set(toks(f))) df.set(t, (df.get(t)||0) + 1);
    const idf = t => Math.log((N + 1) / ((df.get(t)||0) + 1)) + 1;
    for (const f of films) f.tf = vecFor(toks(f), idf);
    return { idf, toks, vec: f => vecFor(toks(f), idf) };
  }
  function vecFor(tokens, idf){
    const m = new Map(); for (const t of tokens) m.set(t, (m.get(t)||0) + idf(t) * (t[0]==='g' ? 0.6 : 1));
    let n = 0; for (const v of m.values()) n += v*v; n = Math.sqrt(n) || 1;
    for (const [k,v] of m) m.set(k, v/n); return m;
  }
  const W_AFFECT = 0.55, W_TEXT = 0.45;
  function similarity(a, b){ return W_AFFECT * cosDense(affectVec(a), affectVec(b)) + W_TEXT * cosSparse(a.tf, b.tf); }

  /* ---- Bayesian average ---- */
  function bayesStats(films){
    const votes = films.map(f=>f.votes||0).sort((a,b)=>a-b);
    const m = Math.max(50, votes[Math.floor(votes.length * 0.25)] || 0);          // prior strength: 25th-percentile vote count
    const tv = films.reduce((s,f)=>s+(f.votes||0),0) || 1;
    const C = films.reduce((s,f)=>s+(f.i||0)*(f.votes||0),0) / tv;                 // vote-weighted mean rating
    return { m, C };
  }
  function bayes(f, {m, C}){ const v = f.votes||0, R = f.i||0; return (v/(v+m))*R + (m/(v+m))*C; }

  /* ---- moods: presets over dimensions (ranges for filtering, midpoints as targets) ---- */
  const MOODS = {
    fg:{label:'Feel-good',  s:'Warm & uplifting',  c:'grass',   r:{V:[.62,1], dark:[0,.4], comfort:[.45,1]}},
    th:{label:'Thriller',   s:'Edge of your seat', c:'fire',    r:{A:[.62,1], dark:[.45,1], pace:[.45,1]}},
    cr:{label:'Have a cry', s:'Bring tissues',     c:'water',   r:{weight:[.6,1]}},
    la:{label:'Laugh',      s:'Proper funny',      c:'electric',r:{humour:[.65,1], dark:[0,.55]}},
    mb:{label:'Mind-bender',s:'Twisty & clever',   c:'psychic', r:{complex:[.65,1]}},
    ch:{label:'Chill',      s:'Cosy, low effort',  c:'violet',  r:{comfort:[.6,1], A:[0,.5], complex:[0,.5]}},
    ad:{label:'Adrenaline', s:'Big, loud, fast',   c:'fire',    r:{A:[.7,1], pace:[.68,1]}},
  };
  function moodTarget(k){ const t = {}; for (const [d,[lo,hi]] of Object.entries(MOODS[k].r)) t[d] = lo===0 ? hi/2 : hi===1 ? (lo+1)/2 : (lo+hi)/2; return t; }
  function fitsMood(f, k){ return Object.entries(MOODS[k].r).every(([d,[lo,hi]]) => { const v = f.dims[d]; return v >= lo && v <= hi; }); }
  function moodsOf(f){ return Object.keys(MOODS).filter(k => fitsMood(f, k)); }

  /* ---- Zillmann mood management ---- */
  const FEELINGS = {
    stressed:{label:'Stressed / wired', V:.2, A:.85},
    low:     {label:'Low / sad',        V:.2, A:.25},
    bored:   {label:'Bored / flat',     V:.45,A:.15},
    happy:   {label:'Happy / buzzing',  V:.85,A:.75},
    calm:    {label:'Calm / content',   V:.75,A:.2},
    tired:   {label:'Tired',            V:.5, A:.1},
  };
  const MATCH = { stressed:{A:.85, dark:.6, pace:.75}, low:{weight:.75, V:.3}, bored:{A:.3, pace:.3, complex:.55},
                  happy:{V:.85, A:.7, humour:.6}, calm:{comfort:.8, A:.25, V:.75}, tired:{comfort:.8, complex:.2, A:.3} };
  const REPAIR = { stressed:{A:.25, V:.85, comfort:.8, dark:.2, complex:.3}, low:{V:.9, humour:.6, weight:.3, dark:.2},
                   bored:{A:.85, pace:.85, complex:.6}, happy:{V:.8, A:.65, humour:.55}, calm:{A:.8, pace:.8, V:.65}, tired:{humour:.7, pace:.65, complex:.25, V:.8} };
  // happy + change: mood management predicts people sustain good moods, so "change" still keeps valence high.
  function moodManagementTarget(feeling, mode){ if (!FEELINGS[feeling]) return null; return { ...(mode === 'change' ? REPAIR : MATCH)[feeling] }; }

  /* ---- target fit ---- */
  function targetFit(f, target){
    const ks = target ? Object.keys(target) : []; if (!ks.length) return { fit: 0.5, terms: [] };
    const terms = ks.map(k => ({ k, t: target[k], v: f.dims[k] ?? 0.5, d: Math.abs((f.dims[k] ?? 0.5) - target[k]) }));
    return { fit: 1 - terms.reduce((s,x)=>s+x.d,0)/terms.length, terms };
  }

  /* ---- Rocchio profile from feedback events ---- */
  const FB_W = { like: 1, fav: 1, watch: 0.5, dislike: -1, notint: -1, skip: -0.3 };
  const BETA = 0.75, GAMMA = 0.25;
  function rocchio(events, byId){
    const pos = { a: new Array(AFFECT.length).fill(0), t: new Map(), n: 0, items: [] }, neg = { a: new Array(AFFECT.length).fill(0), t: new Map(), n: 0 };
    for (const e of events){
      const f = byId(e.id); const w = FB_W[e.type]; if (!f || !w) continue;
      const tgt = w > 0 ? pos : neg, aw = Math.abs(w); const av = affectVec(f);
      av.forEach((x,i)=> tgt.a[i] += aw*x); if (f.tf) for (const [k,v] of f.tf) tgt.t.set(k, (tgt.t.get(k)||0) + aw*v);
      tgt.n += aw; if (w > 0) pos.items.push(f);
    }
    if (!pos.n && !neg.n) return null;
    const a = AFFECT.map((_,i) => BETA*(pos.n ? pos.a[i]/pos.n : 0) - GAMMA*(neg.n ? neg.a[i]/neg.n : 0));
    const t = new Map();
    for (const [k,v] of pos.t) t.set(k, BETA*v/pos.n);
    for (const [k,v] of neg.t) t.set(k, (t.get(k)||0) - GAMMA*v/neg.n);
    let n = 0; for (const v of t.values()) n += v*v; n = Math.sqrt(n)||1; for (const [k,v] of t) t.set(k, v/n);
    return { a, t, liked: pos.items, n: pos.n + neg.n };
  }
  function profileSim(f, P){ if (!P) return 0; return W_AFFECT*cosDense(affectVec(f), P.a) + W_TEXT*cosSparse(f.tf, P.t); }

  /* ---- relevance ---- */
  function relevance(f, ctx){
    const tf = targetFit(f, ctx.target);
    const wr = bayes(f, ctx.bayes); const q = Math.max(0, Math.min(1, (wr - 5) / 3.5));
    const ps = profileSim(f, ctx.profile);
    const svc = 0;
    const qualW = ctx.prefer === 'classic' ? 0.4 : ctx.prefer === 'gem' ? 0.1 : 0.25;
    let gem = 0; if (ctx.prefer === 'gem') gem = (f.votes||0) < 3000 && wr > 6.8 ? 0.15 : 0;
    const score = (ctx.target ? 0.5 : 0.15)*tf.fit + qualW*q + (ctx.profile ? 0.2 : 0)*((ps+1)/2) + gem;
    return { f, score, fit: tf, wr, ps, svc };
  }
  function rank(films, ctx){ return films.map(f => relevance(f, ctx)).sort((a,b)=>b.score-a.score); }

  /* ---- MMR ---- */
  function mmr(ranked, k, lambda = 0.72, pool = 120){
    const cand = ranked.slice(0, pool), out = [];
    if (!cand.length) return out;
    const lo = cand[cand.length-1].score, hi = cand[0].score, norm = s => hi > lo ? (s - lo) / (hi - lo) : 1;
    while (out.length < k && cand.length){
      let best = 0, bestV = -Infinity;
      for (let i=0;i<cand.length;i++){
        const maxSim = out.length ? Math.max(...out.map(o => similarity(cand[i].f, o.f))) : 0;
        const v = lambda * norm(cand[i].score) - (1 - lambda) * maxSim;
        if (v > bestV){ bestV = v; best = i; }
      }
      const pick = cand.splice(best, 1)[0]; pick.mmr = bestV; out.push(pick);
    }
    return out;
  }

  /* ---- explanation ---- */
  const WORDS = { V:['bleak','uplifting'], A:['low-key','high-intensity'], dark:['light in tone','dark'], humour:['not played for laughs','funny'],
    complex:['easy to follow','twisty and demanding'], pace:['slow-burn','fast-paced'], weight:['dry-eyed','a tearjerker'], comfort:['challenging','comforting'],
    family:['grown-up','family-friendly'] };
  const pct = x => Math.round(x*100) + '%';
  function describe(k, v){ const w = WORDS[k]; if (!w) return null; return v >= 0.5 ? `${w[1]} (${pct(v)})` : `${w[0]} (${pct(1-v)})`; }
  function why(r, ctx){
    const parts = [];
    if (ctx.zillmann){ parts.push(ctx.zillmann); }
    if (r.fit && r.fit.terms.length){
      const good = r.fit.terms.filter(t => t.d < 0.2).sort((a,b)=>a.d-b.d).slice(0,2).map(t => describe(t.k, t.v)).filter(Boolean);
      if (good.length) parts.push((ctx.moodLabel ? `Fits ${ctx.moodLabel.toLowerCase()}: ` : 'Matches what you asked for: ') + good.join(', '));
    }
    if (ctx.profile && ctx.profile.liked.length){
      let best = null, bs = 0.62; for (const l of ctx.profile.liked){ if (l.id === r.f.id) continue; const s = similarity(r.f, l); if (s > bs){ bs = s; best = l; } }
      if (best) parts.push(`similar to ${best.t}, which you liked`);
      else if (r.ps > 0.35) parts.push('close to your taste profile');
    }
    parts.push(`${r.wr.toFixed(1)} weighted rating from ${fmtVotes(r.f.votes)} votes`);
    let s = parts.join('; '); s = s.charAt(0).toUpperCase() + s.slice(1) + '.';
    return s;
  }
  const fmtVotes = n => n >= 1000 ? (n/1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n||0);

  /* ---- heuristic dims for films without build-time scores (live TMDB results, offline list) ---- */
  const GP = { Comedy:{valence:.75,humour:.9,comfort:.65,dark:.2,arousal:.4}, Family:{valence:.8,family:.95,comfort:.75,dark:.1,violence:.05,sex:.02},
    Animation:{valence:.75,family:.8,comfort:.7,humour:.55}, Romance:{valence:.65,romance:.95,comfort:.6,weight:.45}, Music:{valence:.7,comfort:.6}, Musical:{valence:.7,comfort:.6},
    Drama:{weight:.55,complex:.5,pace:.3,valence:.45}, Thriller:{arousal:.85,dark:.65,valence:.35,pace:.7,complex:.55,comfort:.15},
    Crime:{dark:.75,violence:.6,arousal:.65,valence:.35}, Horror:{scary:.95,arousal:.85,dark:.85,valence:.15,violence:.7,comfort:.05,family:.02},
    Mystery:{complex:.75,arousal:.6,dark:.5}, 'Sci-Fi':{complex:.65,arousal:.65}, Action:{arousal:.9,pace:.9,violence:.6,valence:.6},
    Adventure:{arousal:.7,pace:.7,valence:.7,family:.5}, War:{dark:.85,violence:.8,weight:.7,valence:.2,arousal:.7}, History:{weight:.55,complex:.55,pace:.3},
    Western:{violence:.55,pace:.45}, Fantasy:{valence:.65,arousal:.6,family:.5}, Documentary:{complex:.55,pace:.3,humour:.1} };
  const BASE = {valence:.5,arousal:.5,dark:.35,humour:.2,complex:.4,pace:.5,weight:.3,comfort:.35,violence:.25,scary:.1,sex:.15,family:.3,romance:.2};
  function heuristicDims(genres){
    const v = {}; DIMS.forEach(d => v[d] = []);
    for (const g of genres||[]) for (const [d,x] of Object.entries(GP[g]||{})) v[d].push(x);
    const out = {}; DIMS.forEach(d => out[d] = v[d].length ? v[d].reduce((a,b)=>a+b,0)/v[d].length : BASE[d]);
    const va = out.valence, ar = out.arousal; const q = {excited:va*ar, content:va*(1-ar), tense:(1-va)*ar, sad:(1-va)*(1-ar)};
    Object.assign(out, circumplex(out, q)); return { dims: out, quad: q };
  }

  return { DIMS, AFFECT, MOODS, FEELINGS, circumplex, affectVec, cosDense, cosSparse, buildTfidf, similarity, bayesStats, bayes,
           moodTarget, fitsMood, moodsOf, moodManagementTarget, targetFit, rocchio, profileSim, relevance, rank, mmr, why, describe, heuristicDims, fmtVotes };
});
