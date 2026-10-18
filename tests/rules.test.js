// Run: node --test tests/   (simulated clock + in-memory localStorage)
const test = require('node:test'), assert = require('node:assert');
const Rules = require('../rules.js');
const DAY = 86400e3;
function mem(){ const m = new Map(); return { getItem:k=>m.has(k)?m.get(k):null, setItem:(k,v)=>m.set(k,String(v)), removeItem:k=>m.delete(k), _m:m }; }
function clock(t0 = Date.UTC(2026, 9, 18, 20)){ let t = t0; const c = () => t; c.advance = ms => { t += ms; }; return c; }
const reopen = (storage, now) => Rules.create({ storage, now }); // simulates a page reload: new session, same storage

test('a suggested film cannot be suggested again for 30 days (survives reload)', () => {
  const s = mem(), now = clock(); let r = reopen(s, now);
  r.markShown('tmdb-1');
  assert.equal(r.eligible('tmdb-1'), false);
  r = reopen(s, now); assert.equal(r.reason('tmdb-1'), 'cooldown');
  now.advance(29 * DAY + 23 * 3600e3); r = reopen(s, now); assert.equal(r.eligible('tmdb-1'), false);
  now.advance(3600e3); r = reopen(s, now); assert.equal(r.eligible('tmdb-1'), true, 'eligible exactly at 30 days');
});

test('never repeats within a session, even after cooldown is cleared from storage', () => {
  const s = mem(), now = clock(); const r = reopen(s, now);
  r.markShown(['a', 'b']);
  s.removeItem('reelpick.rules.v1'); r.reload();
  assert.equal(r.reason('a'), 'session'); assert.equal(r.eligible('b'), false);
  assert.deepEqual(r.filter(['a', 'b', 'c']), ['c']);
  now.advance(40 * DAY); assert.equal(r.eligible('a'), false, 'same session still blocks after 40 days');
  assert.equal(reopen(s, now).eligible('a'), true, 'new session after cooldown is fine');
});

test('three skips ban for one year; strikes persist across reloads', () => {
  const s = mem(), now = clock(); let r = reopen(s, now);
  assert.deepEqual(r.skip('x'), { strikes: 1, banned: false });
  now.advance(2 * DAY); r = reopen(s, now); assert.equal(r.strikes('x'), 1);
  assert.deepEqual(r.skip('x'), { strikes: 2, banned: false });
  now.advance(5 * DAY); r = reopen(s, now);
  assert.deepEqual(r.skip('x'), { strikes: 3, banned: true });
  assert.equal(r.reason('x'), 'banned'); assert.equal(r.banInfo('x').why, 'three-skips');
  const t3 = now();
  now.advance(364 * DAY); r = reopen(s, now); assert.equal(r.reason('x'), 'banned');
  now.advance(DAY); r = reopen(s, now); assert.equal(r.eligible('x'), true, 'ban lifts after 365 days');
  assert.equal(r.strikes('x'), 0, 'strikes reset by the ban');
  assert.equal(t3 + Rules.BAN_MS, t3 + 365 * DAY);
});

test('two skips do not ban', () => {
  const s = mem(), now = clock(); const r = reopen(s, now);
  r.skip('y'); r.skip('y'); assert.equal(r.banInfo('y'), null); assert.equal(r.eligible('y'), true);
});

test('not interested bans for a year immediately', () => {
  const s = mem(), now = clock(); let r = reopen(s, now);
  r.notInterested('z'); assert.equal(r.reason('z'), 'banned'); assert.equal(r.banInfo('z').why, 'not-interested');
  now.advance(200 * DAY); r = reopen(s, now); assert.equal(r.eligible('z'), false);
  now.advance(165 * DAY); r = reopen(s, now); assert.equal(r.eligible('z'), true);
});

test('timestamps are stored and expired entries are pruned', () => {
  const s = mem(), now = clock(); let r = reopen(s, now);
  r.markShown('p'); r.skip('q'); r.notInterested('n');
  const st = JSON.parse(s.getItem('reelpick.rules.v1'));
  assert.equal(st.shown.p, now()); assert.equal(st.strikes.q[0], now()); assert.equal(st.bans.n.until, now() + 365 * DAY);
  assert.ok(st.log.every(e => typeof e.ts === 'number'));
  now.advance(366 * DAY); r = reopen(s, now);
  assert.equal(r.stats().cooldown, 0); assert.equal(r.stats().banned, 0);
});

test('unban and reset', () => {
  const s = mem(), now = clock(); const r = reopen(s, now);
  r.notInterested('u'); r.unban('u'); assert.equal(r.eligible('u'), true);
  r.markShown('v'); r.reset(); assert.equal(r.eligible('v'), true); assert.equal(reopen(s, now).eligible('v'), true);
});

test('corrupt storage does not crash', () => {
  const s = mem(); s.setItem('reelpick.rules.v1', '{not json'); const r = reopen(s, clock()); assert.equal(r.eligible('a'), true);
});
