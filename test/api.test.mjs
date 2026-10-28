// API contract tests. Run through test/run.mjs, which starts a server and sets BASE and ADMIN_KEY.
import { test, describe, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const BASE = process.env.BASE;
const ADMIN = process.env.ADMIN_KEY;
const JSON_HEADERS = { 'content-type': 'application/json' };

let seq = 0;
const uid = (prefix = 'op') => `${prefix}-${process.pid}-${++seq}-xxxxxx`;
// Unique in the first 8 characters, which is all pages see.
const deviceFor = () => (++seq * 7919).toString(16).padStart(8, '0').padEnd(32, '0');
// Each test talks from its own address so the per-IP limit on new tallies doesn't interfere.
const ipFor = () => `10.${(seq >> 16) & 255}.${(seq >> 8) & 255}.${++seq & 255}`;

async function req(method, path, { body, headers = {}, raw } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { ...(body !== undefined ? JSON_HEADERS : {}), ...headers },
    body: raw ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, headers: res.headers, text, json };
}

async function createTally(fields = {}) {
  const r = await req('POST', '/api/tallies', {
    body: { name: 'Test tally', ...fields },
    headers: { 'x-forwarded-for': ipFor() },
  });
  assert.equal(r.status, 201, r.text);
  return r.json;
}

const count = (id, fields) =>
  req('POST', `/api/tallies/${id}/entries`, { body: { delta: 1, who: 'Sam', opId: uid(), device: deviceFor(), ...fields } });

function embeddedSnapshot(html) {
  const m = html.match(/<script id="snapshot" type="application\/json">(.*?)<\/script>/s);
  assert.ok(m, 'page has an embedded snapshot');
  return JSON.parse(m[1]);
}

// Every stream gets closed at the end, even when a failing test skips its own close().
const openStreams = new Set();
after(() => openStreams.forEach((close) => close()));

// Minimal Server-Sent Events reader.
function openStream(path, headers = {}) {
  const controller = new AbortController();
  openStreams.add(() => controller.abort());
  const events = [];
  const waiters = [];
  let status;
  const ready = fetch(BASE + path, { headers, signal: controller.signal }).then(async (res) => {
    status = res.status;
    if (!res.ok) return;
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += value;
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const ev = { event: 'message', data: '', id: undefined };
          for (const line of block.split('\n')) {
            if (line.startsWith(':')) continue;
            const [k, ...rest] = line.split(':');
            const v = rest.join(':').replace(/^ /, '');
            if (k === 'event') ev.event = v;
            else if (k === 'data') ev.data += v;
            else if (k === 'id') ev.id = v;
          }
          if (!ev.data) continue;
          ev.json = JSON.parse(ev.data);
          events.push(ev);
          for (const w of [...waiters]) w();
        }
      }
    } catch {}
    for (const w of [...waiters]) w();
  });
  async function next(pred, timeout = 3000) {
    const deadline = Date.now() + timeout;
    for (;;) {
      const found = events.find(pred);
      if (found) return found;
      if (Date.now() > deadline) throw new Error(`no matching event; got ${JSON.stringify(events.map((e) => e.event))}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  }
  return { events, next, ready: ready.then(() => status), close: () => controller.abort(), get status() { return status; } };
}

// Entries pushed to a stream, whether sent one per event or batched.
const pushedEntries = (s) =>
  s.events.flatMap((e) => (e.event === 'message' ? [e.json] : e.event === 'entries' ? e.json : []));

describe('pages and static files', () => {
  test('home, assets, robots and headers', async () => {
    const home = await req('GET', '/');
    assert.equal(home.status, 200);
    assert.match(home.headers.get('content-type'), /text\/html/);
    assert.match(home.text, /<title>FreeTally<\/title>/);
    for (const file of ['app.css', 'home.js', 'tally.js', 'screen.js', 'live.js', 'fx.js', 'admin.js']) {
      const r = await req('GET', `/${file}`);
      assert.equal(r.status, 200, file);
    }
    const robots = await req('GET', '/robots.txt');
    assert.equal(robots.text, 'User-agent: *\nDisallow: /\n');
    assert.equal(home.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet');
    const missing = await req('GET', '/nope');
    assert.equal(missing.status, 404);
    assert.equal(missing.headers.get('x-robots-tag'), 'noindex, nofollow, noarchive, nosnippet');
  });

  test('gzip is used when the browser accepts it', async () => {
    const res = await fetch(`${BASE}/app.css`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    assert.match(res.headers.get('vary') ?? '', /accept-encoding/i);
  });

  test('security headers, with inline scripts allowed only by hash', async () => {
    const { id } = await createTally();
    for (const path of ['/', '/app.css', '/api/tallies', `/t/${id}`, `/t/${id}/screen`, `/admin/${ADMIN}`, '/nope']) {
      const r = await req('GET', path);
      assert.equal(r.headers.get('x-content-type-options'), 'nosniff', path);
      assert.equal(r.headers.get('x-frame-options'), 'DENY', path);
      assert.equal(r.headers.get('referrer-policy'), 'no-referrer', path);
      const policy = r.headers.get('content-security-policy');
      assert.match(policy, /default-src 'none'.*frame-ancestors 'none'/, path);
      assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/, path);
      const scripts = [...r.text.matchAll(/<script>(.*?)<\/script>/gs)].map((m) => createHash('sha256').update(m[1]).digest('base64'));
      const allowed = [...policy.matchAll(/'sha256-([^']+)'/g)].map((m) => m[1]);
      assert.deepEqual(allowed, scripts, path);
    }
  });

  test('tally pages carry the escaped name from the start', async () => {
    const { id } = await createTally({ name: 'Door <b>&</b> "bar"' });
    for (const path of [`/t/${id}`, `/t/${id}/screen`]) {
      const page = await req('GET', path);
      assert.match(page.text, /<h1 id="title">Door &lt;b&gt;&amp;&lt;\/b&gt; &#34;bar&#34;<\/h1>/);
      assert.doesNotMatch(page.text, /\{\{name\}\}|<b>&/);
    }
  });

  test('tally pages carry the snapshot, so they draw the tally without waiting for it', async () => {
    const { id } = await createTally({ name: 'Door', capacity: 40 });
    await count(id, { delta: 3, who: 'Sam' });
    await count(id, { delta: -1, who: 'Jo' });
    const api = (await req('GET', `/api/tallies/${id}/snapshot`)).json;
    for (const path of [`/t/${id}`, `/t/${id}/screen`]) {
      const page = await req('GET', path);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      const snap = embeddedSnapshot(page.text);
      assert.deepEqual(snap.tally, api.tally);
      assert.deepEqual(snap.entries, api.entries);
      assert.equal(snap.count, 2);
      assert.equal(snap.url, api.url);
      assert.ok(Math.abs(snap.now - Date.now()) < 5000);
    }
  });

  test('names in the embedded snapshot cannot break out of it', async () => {
    const evil = '</script><script>alert(1)</script><!-- {{snapshot}} {{name}}';
    const { id } = await createTally({ name: evil });
    await count(id, { who: '</SCRIPT><img src=x onerror=alert(1)>' });
    for (const path of [`/t/${id}`, `/t/${id}/screen`]) {
      const page = await req('GET', path);
      assert.doesNotMatch(page.text, /<script>alert|<img src=x|<!--/i);
      // Only the page's own scripts close.
      assert.equal(page.text.match(/<\/script>/gi).length, page.text.match(/<script/gi).length);
      const snap = embeddedSnapshot(page.text);
      assert.equal(snap.tally.name, evil);
      assert.equal(snap.entries[0].who, '</SCRIPT><img src=x onerror=alert(1)>');
    }
  });

  test('tally pages exist only for real tallies', async () => {
    const { id } = await createTally();
    assert.equal((await req('GET', `/t/${id}`)).status, 200);
    assert.equal((await req('GET', `/t/${id}/screen`)).status, 200);
    const missing = await req('GET', '/t/zzzzzzzzzz');
    assert.equal(missing.status, 404);
    assert.match(missing.text, /Tally not found/);
    assert.equal((await req('GET', '/t/zzzzzzzzzz/screen')).status, 404);
  });

  test('QR code is an SVG of the tally link', async () => {
    const { id } = await createTally();
    const r = await req('GET', `/api/tallies/${id}/qr.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(r.text, /^<svg/);
  });
});

describe('creating tallies', () => {
  test('returns an id and an owner key', async () => {
    const t = await createTally({ capacity: 50 });
    assert.match(t.id, /^[a-z0-9]{10}$/);
    assert.ok(t.ownerKey.length >= 32);
  });

  test('validates name and capacity', async () => {
    const bad = async (body) => (await req('POST', '/api/tallies', { body, headers: { 'x-forwarded-for': ipFor() } })).status;
    assert.equal(await bad({}), 400);
    assert.equal(await bad({ name: '   ' }), 400);
    assert.equal(await bad({ name: 'x', capacity: -3 }), 400);
    assert.equal(await bad({ name: 'x', capacity: 0 }), 400);
    assert.equal(await bad({ name: 'x', capacity: 1.5 }), 400);
    assert.equal(await bad({ name: 'x', capacity: 'abc' }), 400);
    assert.equal(await bad({ name: 'x', capacity: 2_000_000 }), 400);
    const blankCapacity = await req('POST', '/api/tallies', { body: { name: 'x', capacity: '' }, headers: { 'x-forwarded-for': ipFor() } });
    assert.equal(blankCapacity.status, 201);
  });

  test('rejects bad JSON and oversized bodies', async () => {
    assert.equal((await req('POST', '/api/tallies', { raw: '{nope', headers: JSON_HEADERS })).status, 400);
    const big = await req('POST', '/api/tallies', { raw: JSON.stringify({ name: 'x'.repeat(5000) }), headers: JSON_HEADERS });
    assert.equal(big.status, 413);
  });
});

describe('counting', () => {
  test('counts visitors: arrivals add, leaving and undoing a leave do not, undoing an arrival does', async () => {
    const { id } = await createTally();
    const device = deviceFor();
    const step = async (fields) => (await count(id, { device, ...fields })).json;
    const arrive = await step({ delta: 3 });
    assert.deepEqual([arrive.total, arrive.visitors], [3, 3]);
    const leave = await step({ delta: -1 });
    assert.deepEqual([leave.total, leave.visitors], [2, 3]);
    const undoLeave = await step({ delta: 1, undoes: leave.id });
    assert.deepEqual([undoLeave.total, undoLeave.visitors], [3, 3]);
    const more = await step({ delta: 2 });
    assert.deepEqual([more.total, more.visitors], [5, 5]);
    const undoMore = await step({ delta: -2, undoes: more.id });
    assert.deepEqual([undoMore.total, undoMore.visitors], [3, 3]);
  });

  test('keeps a running total', async () => {
    const { id } = await createTally();
    const device = deviceFor();
    const a = await count(id, { delta: 5, device });
    const b = await count(id, { delta: -2, device });
    assert.equal(a.status, 201);
    assert.deepEqual([a.json.total, b.json.total], [5, 3]);
    assert.equal(b.json.who, 'Sam');
    assert.equal(b.json.device, device.slice(0, 8));
    assert.equal(b.json.undoes, undefined);
    assert.equal(typeof b.json.at, 'number');
  });

  test('a retried tap is recorded once', async () => {
    const { id } = await createTally();
    const opId = uid();
    const first = await count(id, { opId });
    const again = await count(id, { opId });
    assert.equal(first.status, 201);
    assert.equal(again.status, 200);
    assert.equal(again.json.id, first.json.id);
  });

  test('50 phones at once never miscount', async () => {
    const { id } = await createTally();
    const results = await Promise.all(Array.from({ length: 50 }, () => count(id)));
    assert.ok(results.every((r) => r.status === 201));
    const totals = results.map((r) => r.json.total).sort((x, y) => x - y);
    assert.deepEqual(totals, Array.from({ length: 50 }, (_, i) => i + 1));
  });

  test('validates every field', async () => {
    const { id } = await createTally();
    const bad = async (fields) => (await count(id, fields)).status;
    for (const delta of [0, 1.5, 1_000_001, -1_000_001, 'one', null]) assert.equal(await bad({ delta }), 400, `delta ${delta}`);
    assert.equal(await bad({ who: '' }), 400);
    assert.equal(await bad({ who: '​ ‮' }), 400);
    assert.equal(await bad({ opId: 'short' }), 400);
    assert.equal(await bad({ opId: 'has spaces in it' }), 400);
    assert.equal(await bad({ device: '<script>' }), 400);
    assert.equal(await bad({ device: 'A'.repeat(32) }), 400);
    assert.equal((await count('zzzzzzzzzz')).status, 404);
  });

  test('cleans names', async () => {
    const { id } = await createTally({ name: '  Front​   door‮\n ' });
    const r = await count(id, { who: ' ⁦Sam\u0007  at\tthe ​ bar‍ ' });
    assert.equal(r.json.who, 'Sam at the bar');
    const long = await count(id, { who: 'x'.repeat(60) });
    assert.equal(long.json.who.length, 40);
    const s = openStream(`/api/tallies/${id}/events`);
    const snap = await s.next((e) => e.event === 'snapshot');
    s.close();
    assert.equal(snap.json.tally.name, 'Front door');
  });

  test('pages from before device ids still work', async () => {
    const { id } = await createTally();
    const r = await req('POST', `/api/tallies/${id}/entries`, { body: { delta: 1, who: 'Old page', opId: uid() } });
    assert.equal(r.status, 201);
    assert.equal(r.json.device, undefined);
  });
});

describe('live stream', () => {
  test('starts with a snapshot, then pushes new entries', async () => {
    const { id } = await createTally({ name: 'Live', capacity: 9 });
    await count(id, { delta: 2 });
    const s = openStream(`/api/tallies/${id}/events`);
    const snap = await s.next((e) => e.event === 'snapshot');
    assert.equal(snap.json.tally.name, 'Live');
    assert.equal(snap.json.tally.capacity, 9);
    assert.equal(snap.json.tally.closedAt, null);
    assert.equal(snap.json.count, 1);
    assert.equal(snap.json.entries.length, 1);
    assert.match(snap.json.url, new RegExp(`/t/${id}$`));
    assert.ok(Math.abs(snap.json.now - Date.now()) < 5000);
    const added = await count(id, { delta: 3 });
    await s.next(() => pushedEntries(s).some((e) => e.id === added.json.id));
    s.close();
  });

  test('a missing tally has no stream', async () => {
    const s = openStream('/api/tallies/zzzzzzzzzz/events');
    assert.equal(await s.ready, 404);
  });
});

describe('undo', () => {
  test('only your own change, only once, by the exact amount', async () => {
    const { id } = await createTally();
    const mine = deviceFor();
    const entry = (await count(id, { delta: 2, device: mine })).json;
    const undo = (fields) => count(id, { delta: -2, device: mine, undoes: entry.id, ...fields });
    assert.equal((await undo({ device: deviceFor() })).status, 403);
    assert.equal((await undo({ delta: -1 })).status, 400);
    assert.equal((await undo({ undoes: 999999 })).status, 400);
    const opId = uid();
    const ok = await undo({ opId });
    assert.equal(ok.status, 201);
    assert.equal(ok.json.undoes, entry.id);
    assert.equal(ok.json.total, 0);
    assert.equal((await undo()).status, 409);
    assert.equal((await undo({ opId })).status, 200, 'a retry of the undo still succeeds');
    assert.equal((await count(id, { delta: 2, device: mine, undoes: ok.json.id })).status, 400, 'an undo cannot be undone');
  });

  test('pages see only the start of a device id, which is not enough to undo', async () => {
    const { id } = await createTally();
    const mine = deviceFor();
    const s = openStream(`/api/tallies/${id}/events?v=2`);
    await s.next((e) => e.event === 'tally');
    const legacy = openStream(`/api/tallies/${id}/events`);
    await legacy.next((e) => e.event === 'snapshot');
    const entry = (await count(id, { delta: 2, device: mine })).json;
    const batch = await s.next((e) => e.event === 'entries');
    const message = await legacy.next((e) => e.event === 'message');
    const snap = (await req('GET', `/api/tallies/${id}/snapshot`)).json;
    for (const seen of [entry, batch.json[0], message.json, snap.entries[0]]) assert.equal(seen.device, mine.slice(0, 8));
    assert.equal((await count(id, { delta: -2, device: entry.device, undoes: entry.id })).status, 403);
    assert.equal((await count(id, { delta: -2, device: mine, undoes: entry.id })).status, 201);
    s.close();
    legacy.close();
  });
});

describe('closing', () => {
  test('stops counting until reopened, and tells open pages', async () => {
    const { id } = await createTally();
    const opId = uid();
    await count(id, { opId });
    const s = openStream(`/api/tallies/${id}/events`);
    await s.next((e) => e.event === 'snapshot');
    const closed = await req('POST', `/api/admin/${ADMIN}/tallies/${id}/close`);
    assert.equal(closed.status, 200);
    assert.equal(typeof closed.json.closedAt, 'number');
    await s.next((e) => e.event === 'tally' && e.json.closedAt);
    assert.equal((await count(id)).status, 409);
    assert.equal((await count(id, { opId })).status, 200, 'a retry of an earlier tap still succeeds');
    const reopened = await req('POST', `/api/admin/${ADMIN}/tallies/${id}/reopen`);
    assert.equal(reopened.json.closedAt, null);
    assert.equal((await count(id)).status, 201);
    s.close();
  });
});

describe('owner editing', () => {
  test('needs the owner key and valid fields', async () => {
    const { id, ownerKey } = await createTally({ name: 'Before', capacity: 10 });
    const edit = (body, key) =>
      req('PATCH', `/api/tallies/${id}`, { body, headers: key === undefined ? {} : { 'x-owner-key': key } });
    assert.equal((await edit({ name: 'x' })).status, 403);
    assert.equal((await edit({ name: 'x' }, 'wrong')).status, 403);
    assert.equal((await edit({ name: '' }, ownerKey)).status, 400);
    const s = openStream(`/api/tallies/${id}/events`);
    await s.next((e) => e.event === 'snapshot');
    const ok = await edit({ name: 'After', capacity: null }, ownerKey);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.name, 'After');
    assert.equal(ok.json.capacity, null);
    assert.equal(ok.json.ownerKeyHash, undefined);
    await s.next((e) => e.event === 'tally' && e.json.name === 'After');
    s.close();
  });

  test('tallies from before owner keys cannot be edited', async () => {
    const r = await req('PATCH', '/api/tallies/legacy2345', { body: { name: 'x' }, headers: { 'x-owner-key': 'anything' } });
    assert.equal(r.status, 403);
  });
});

describe('admin', () => {
  test('a wrong key looks like nothing is there', async () => {
    assert.equal((await req('GET', '/admin/wrong_key_0123456789abcdefghijklmnop')).status, 404);
    assert.equal((await req('GET', '/api/admin/wrong/tallies')).status, 404);
    const page = await req('GET', `/admin/${ADMIN}`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
  });

  test('lists tallies with their numbers', async () => {
    const { id } = await createTally({ name: 'Listed', capacity: 7 });
    await count(id, { delta: 4, who: 'A' });
    await count(id, { delta: 1, who: 'B' });
    const list = await req('GET', `/api/admin/${ADMIN}/tallies`);
    const t = list.json.find((x) => x.id === id);
    assert.deepEqual(
      { name: t.name, capacity: t.capacity, total: t.total, visitors: t.visitors, changes: t.changes, people: t.people, closedAt: t.closedAt },
      { name: 'Listed', capacity: 7, total: 5, visitors: 5, changes: 2, people: 2, closedAt: null },
    );
    assert.equal(typeof t.lastAt, 'number');
    assert.equal(list.text.includes('owner'), false);
  });

  test('exports CSV safely', async () => {
    const { id } = await createTally({ name: 'Door: Saturday!' });
    const first = await count(id, { delta: 2, who: '=HYPERLINK("x")' });
    await count(id, { delta: 1, who: 'Sam, "the counter"' });
    const r = await req('GET', `/api/admin/${ADMIN}/tallies/${id}/export.csv`);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.equal(r.headers.get('content-disposition'), 'attachment; filename="door-saturday.csv"');
    const lines = r.text.trimEnd().split('\r\n');
    assert.equal(lines[0], 'time_utc,who,change,total,visitors,undoes_change');
    assert.equal(lines[1], `${new Date(first.json.at).toISOString()},"'=HYPERLINK(""x"")",2,2,2,`);
    assert.match(lines[2], /,"Sam, ""the counter""",1,3,3,$/);
  });

  test('keeps a log of pages opening and closing for each tally', async () => {
    const { id } = await createTally({ name: 'Logged' });
    const s = openStream(`/api/tallies/${id}/events?v=2&after=0`);
    await s.next((e) => e.event === 'tally');
    s.close();
    const log = async () => (await req('GET', `/api/admin/${ADMIN}/tallies/${id}/log.csv`)).text;
    let text;
    for (let i = 0; i < 40 && !(text = await log()).includes('page closed'); i++) await new Promise((r) => setTimeout(r, 50));
    const lines = text.trimEnd().split('\r\n');
    assert.equal(lines[0], 'time_utc,scope,event,detail');
    assert.ok(lines.some((l) => /,tally,page opened,"\{.*""pages"":1/.test(l)), text);
    assert.ok(lines.some((l) => /,tally,page closed,"\{.*""why"":""closed""/.test(l)), text);
    assert.equal((await req('GET', `/api/admin/wrong_key_0123456789abcdefghijklmnop/tallies/${id}/log.csv`)).status, 404);
  });

  test('owner link replaces the owner key', async () => {
    const { id, ownerKey } = await createTally({ name: 'Lost owner' });
    const edit = (key) => req('PATCH', `/api/tallies/${id}`, { body: { name: 'Found owner' }, headers: { 'x-owner-key': key } });
    assert.equal((await req('POST', `/api/admin/wrong_key_0123456789abcdefghijklmnop/tallies/${id}/owner-key`)).status, 404);
    assert.equal((await req('GET', `/api/admin/${ADMIN}/tallies/${id}/owner-key`)).status, 404);
    assert.equal((await req('POST', `/api/admin/${ADMIN}/tallies/nosuchtally/owner-key`)).status, 404);

    const r = await req('POST', `/api/admin/${ADMIN}/tallies/${id}/owner-key`);
    assert.equal(r.status, 200);
    assert.ok(r.json.ownerKey.length >= 32);
    assert.notEqual(r.json.ownerKey, ownerKey);
    assert.equal(new URL(r.json.url).pathname, `/t/${id}`);
    assert.equal(new URL(r.json.url).hash, `#owner=${r.json.ownerKey}`);

    assert.equal((await edit(ownerKey)).status, 403);
    const ok = await edit(r.json.ownerKey);
    assert.equal(ok.status, 200);
    assert.equal(ok.json.name, 'Found owner');
  });

  test('delete removes the tally and tells open pages', async () => {
    const { id } = await createTally();
    await count(id);
    const s = openStream(`/api/tallies/${id}/events`);
    await s.next((e) => e.event === 'snapshot');
    const del = await req('DELETE', `/api/admin/${ADMIN}/tallies/${id}`);
    assert.deepEqual(del.json, { deleted: id });
    await s.next((e) => e.event === 'deleted');
    assert.equal((await req('GET', `/t/${id}`)).status, 404);
    assert.equal((await count(id)).status, 404);
  });
});

describe('upgrading an existing database', () => {
  test('a tally from the first release still loads and counts', async () => {
    const s = openStream('/api/tallies/legacy2345/events');
    const snap = await s.next((e) => e.event === 'snapshot');
    s.close();
    assert.equal(snap.json.tally.name, 'Legacy tally');
    assert.equal(snap.json.tally.capacity, null);
    assert.deepEqual(snap.json.entries.map((e) => [e.total, e.device, e.undoes]), [[3, undefined, undefined], [5, undefined, undefined]]);
    assert.deepEqual(snap.json.entries.map((e) => e.visitors), [5, 5], 'visitors worked out for old entries');
    const r = await count('legacy2345', { delta: 1 });
    assert.equal(r.json.total, 4);
    assert.equal(r.json.visitors, 6);
  });
});

describe('rate limits', () => {
  test('one phone can burst 20, then slows down; others are unaffected', async () => {
    const { id } = await createTally();
    const device = deviceFor();
    const firstOp = uid();
    const started = Date.now();
    const burst = await Promise.all(Array.from({ length: 30 }, (_, i) => count(id, { device, opId: i === 0 ? firstOp : uid() })));
    // The bucket refills at 10 a second while the burst is in flight.
    const refill = Math.floor(((Date.now() - started) / 1000) * 10);
    const ok = burst.filter((r) => r.status === 201).length;
    assert.ok(ok >= 20 && ok <= 20 + refill, `${ok} got through with ${refill} refilled`);
    assert.equal(burst.filter((r) => r.status === 429).length, 30 - ok);
    assert.ok(ok < 30, 'some were limited');
    assert.equal((await count(id, { device, opId: firstOp })).status, 200, 'retries are not limited');
    assert.equal((await count(id)).status, 201);
  });

  test('30 new tallies a minute per address', async () => {
    const ip = ipFor();
    const results = await Promise.all(
      Array.from({ length: 31 }, () => req('POST', '/api/tallies', { body: { name: 'x' }, headers: { 'x-forwarded-for': `1.2.3.4, ${ip}` } })),
    );
    assert.equal(results.filter((r) => r.status === 201).length, 30);
    assert.equal(results.filter((r) => r.status === 429).length, 1);
  });

  test('500 open pages per tally', async () => {
    const { id } = await createTally();
    const headers = { 'x-forwarded-for': ipFor() };
    const streams = Array.from({ length: 500 }, () => openStream(`/api/tallies/${id}/events`, headers));
    const statuses = await Promise.all(streams.map((s) => s.next((e) => e.event === 'snapshot', 15000).then(() => 200)));
    assert.equal(statuses.length, 500);
    const extra = openStream(`/api/tallies/${id}/events`, { 'x-forwarded-for': ipFor() });
    assert.equal(await extra.ready, 503);
    streams.forEach((s) => s.close());
  });

  test('500 open pages per address, across tallies', async () => {
    const [a, b, c] = [await createTally(), await createTally(), await createTally()];
    const headers = { 'x-forwarded-for': ipFor() };
    const streams = Array.from({ length: 500 }, (_, i) => openStream(`/api/tallies/${i % 2 ? a.id : b.id}/events`, headers));
    await Promise.all(streams.map((s) => s.next((e) => e.event === 'snapshot', 15000)));
    assert.equal(await openStream(`/api/tallies/${c.id}/events`, headers).ready, 429);
    const other = openStream(`/api/tallies/${c.id}/events`, { 'x-forwarded-for': ipFor() });
    await other.next((e) => e.event === 'snapshot');
    other.close();
    streams.forEach((s) => s.close());
  });
});

describe('current live stream (v=2)', () => {
  const v2 = (id, after = 0, headers = {}) => openStream(`/api/tallies/${id}/events?v=2&after=${after}`, headers);
  const batches = (s) => s.events.filter((e) => e.event === 'entries');

  test('snapshot comes separately, gzipped', async () => {
    const { id } = await createTally({ name: 'Snap' });
    for (let i = 0; i < 20; i++) await count(id);
    const res = await fetch(`${BASE}/api/tallies/${id}/snapshot`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal(res.headers.get('content-encoding'), 'gzip');
    const snap = await res.json();
    assert.equal(snap.tally.name, 'Snap');
    assert.equal(snap.count, 20);
    assert.equal(snap.entries[0].total, 20);
    assert.equal(snap.entries[0].opId, undefined);
    assert.equal((await req('GET', '/api/tallies/zzzzzzzzzz/snapshot')).status, 404);
  });

  test('a page gets only what it missed', async () => {
    const { id } = await createTally();
    const a = (await count(id)).json;
    const b = (await count(id)).json;
    const c = (await count(id)).json;
    const s = v2(id, a.id);
    await s.next((e) => e.event === 'tally');
    const missed = await s.next((e) => e.event === 'entries');
    assert.deepEqual(missed.json.map((e) => e.id), [b.id, c.id]);
    assert.equal(missed.id, String(c.id));
    s.close();
    // A browser reconnecting sends Last-Event-ID, which wins over the address it first used.
    const again = v2(id, 0, { 'last-event-id': String(b.id) });
    const rest = await again.next((e) => e.event === 'entries');
    assert.deepEqual(rest.json.map((e) => e.id), [c.id]);
    again.close();
    const upToDate = v2(id, c.id);
    await upToDate.next((e) => e.event === 'tally');
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(batches(upToDate).length, 0);
    upToDate.close();
  });

  test('too far behind means start again', async () => {
    const { id } = await createTally();
    // 1001 changes from many phones, paced under the per-tally limit.
    for (let round = 0; round < 5; round++) {
      await Promise.all(Array.from({ length: round < 4 ? 250 : 1 }, () => count(id)));
      if (round < 4) await new Promise((r) => setTimeout(r, 1300));
    }
    const s = v2(id, 0);
    await s.next((e) => e.event === 'reset');
    assert.equal(batches(s).length, 0);
    s.close();
  });

  test('batches wait for a quiet door', async () => {
    const { id } = await createTally();
    const s = v2(id);
    await s.next((e) => e.event === 'tally');
    await count(id);
    await count(id);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(batches(s).length, 0, 'nothing yet while taps are still coming');
    const batch = await s.next((e) => e.event === 'entries', 2000);
    assert.equal(batch.json.length, 2);
    s.close();
  });

  test('20 waiting changes go straight away', async () => {
    const { id } = await createTally();
    const s = v2(id);
    await s.next((e) => e.event === 'tally');
    const started = Date.now();
    await Promise.all(Array.from({ length: 20 }, () => count(id)));
    const batch = await s.next((e) => e.event === 'entries', 2000);
    assert.ok(Date.now() - started < 250, 'sent before the quiet period');
    assert.equal(batch.json.length, 20);
    s.close();
  });

  test('a steady trickle still shows by the maximum wait', async () => {
    const { id } = await createTally();
    const s = v2(id);
    await s.next((e) => e.event === 'tally');
    const started = Date.now();
    const trickle = (async () => {
      for (let i = 0; i < 8; i++) {
        await count(id);
        await new Promise((r) => setTimeout(r, 200));
      }
    })();
    const batch = await s.next((e) => e.event === 'entries', 3000);
    const waited = Date.now() - started;
    assert.ok(waited >= 900 && waited < 1400, `sent after ${waited}ms`);
    assert.ok(batch.json.length < 8);
    await trickle;
    s.close();
  });

  test('near capacity, every change goes straight away', async () => {
    const { id } = await createTally({ capacity: 10 });
    const eight = (await count(id, { delta: 8 })).json;
    const s = v2(id, eight.id);
    await s.next((e) => e.event === 'tally');
    const started = Date.now();
    await count(id);
    const batch = await s.next((e) => e.event === 'entries', 2000);
    assert.ok(Date.now() - started < 200);
    assert.equal(batch.json[0].total, 9);
    s.close();
  });

  test('older pages still get each change at once', async () => {
    const { id } = await createTally();
    const legacy = openStream(`/api/tallies/${id}/events`);
    await legacy.next((e) => e.event === 'snapshot');
    const started = Date.now();
    const e = (await count(id)).json;
    await legacy.next((x) => x.event === 'message' && x.json.id === e.id, 1000);
    assert.ok(Date.now() - started < 200);
    legacy.close();
  });
});
