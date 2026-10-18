const test = require('node:test'), assert = require('node:assert');
const R = require('../reco.js');
const mk = (id, g, dims, votes = 1000, i = 7) => { const f = { id, t: id, g, kw: [], votes, i, dims: Object.assign({ valence:.5, arousal:.5, dark:.3, humour:.2, complex:.4, pace:.5, weight:.3, comfort:.4, violence:.2, scary:.1, sex:.1, family:.3, romance:.2 }, dims) };
  Object.assign(f.dims, R.circumplex(f.dims, null)); return f; };

test('Bayesian average pulls low-vote films toward the mean', () => {
  const films = [mk('a', [], {}, 50, 9.8), mk('b', [], {}, 50000, 8.6), mk('c', [], {}, 20000, 6.5), mk('d', [], {}, 3000, 7)];
  const st = R.bayesStats(films);
  assert.ok(R.bayes(films[0], st) < R.bayes(films[1], st), '9.8 from 50 votes ranks below 8.6 from 50k');
  assert.ok(Math.abs(R.bayes(films[1], st) - 8.6) < 0.1);
});

test('cosine similarity: same affect + genres > different', () => {
  const a = mk('a', ['Comedy','Family'], { valence:.9, humour:.9, comfort:.8 }), b = mk('b', ['Comedy','Family'], { valence:.85, humour:.85, comfort:.75 }), c = mk('c', ['Horror'], { valence:.1, dark:.9, arousal:.9, scary:.9 });
  R.buildTfidf([a, b, c]);
  assert.ok(R.similarity(a, b) > R.similarity(a, c));
  assert.ok(R.similarity(a, b) > 0.8);
});

test('MMR diversifies: picks a dissimilar second item over a near-duplicate', () => {
  const a = mk('a', ['Action'], { arousal:.95, pace:.95 }), a2 = mk('a2', ['Action'], { arousal:.94, pace:.94 }), z = mk('z', ['Drama','Romance'], { arousal:.2, weight:.8, romance:.9 });
  R.buildTfidf([a, a2, z]);
  const ranked = [{ f:a, score:1 }, { f:a2, score:.98 }, { f:z, score:.8 }];
  assert.deepEqual(R.mmr(ranked, 2, 0.5).map(r => r.f.id), ['a', 'z']);
  assert.deepEqual(R.mmr(ranked, 2, 1).map(r => r.f.id), ['a', 'a2'], 'lambda=1 is pure relevance');
});

test('Rocchio: liking comedies raises similar films, disliking horror lowers horror', () => {
  const com = mk('com', ['Comedy'], { humour:.9, valence:.85 }), com2 = mk('com2', ['Comedy'], { humour:.85, valence:.8 }), hor = mk('hor', ['Horror'], { scary:.9, dark:.9, valence:.1 }), hor2 = mk('hor2', ['Horror'], { scary:.85, dark:.85, valence:.15 });
  R.buildTfidf([com, com2, hor, hor2]); const by = id => ({ com, com2, hor, hor2 })[id];
  const P = R.rocchio([{ id:'com', type:'like' }, { id:'hor', type:'dislike' }], by);
  assert.ok(R.profileSim(com2, P) > 0.3); assert.ok(R.profileSim(hor2, P) < 0);
});

test('mood management: change-my-mood when stressed targets calm & pleasant; match targets tense', () => {
  const ch = R.moodManagementTarget('stressed', 'change'), ma = R.moodManagementTarget('stressed', 'match');
  assert.ok(ch.A < .4 && ch.V > .7); assert.ok(ma.A > .7);
  const calm = mk('calm', ['Comedy'], { valence:.9, arousal:.15, comfort:.85, dark:.1, complex:.2 }), tense = mk('tense', ['Thriller'], { valence:.2, arousal:.9, dark:.7, pace:.8 });
  assert.ok(R.targetFit(calm, ch).fit > R.targetFit(tense, ch).fit);
  assert.ok(R.targetFit(tense, ma).fit > R.targetFit(calm, ma).fit);
});

test('why text mentions the concrete reasons', () => {
  const f = mk('f', ['Comedy'], { humour:.9, valence:.9, comfort:.8 }, 20000, 7.8); R.buildTfidf([f]);
  const ctx = { bayes:{ m:500, C:6.5 }, target:R.moodTarget('la'), moodLabel:'Laugh', services:new Set() };
  const w = R.why(R.relevance(f, ctx), ctx);
  assert.match(w, /funny/); assert.match(w, /weighted rating/);
});
