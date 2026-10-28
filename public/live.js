// Shared by the tally page and the big-screen view.

export const RECENT_WINDOW = 15 * 60_000;
// Caps memory on a page left open through a long event.
const MAX_ENTRIES = 2000;

// The dot is part of the text, so a new status replaces it rather than moving it.
export const statusText = (state, offline, closed) =>
  `● ${closed ? 'Counting closed' : offline ? (state.everLive ? 'Reconnecting' : 'Connecting') : 'Live'}`;

export const visitorsText = (n) => `${n.toLocaleString()} ${n === 1 ? 'visitor' : 'visitors'} in total`;
export const fmtDelta = (d) => `${d > 0 ? '+' : '-'}${Math.abs(d).toLocaleString()}`;

// Starts from the snapshot the page arrived with, then listens for batches of new entries. When
// the browser reconnects it sends the last entry id it saw, and the server replies with only what
// was missed. The caller renders once this returns.
export function connect(id, { onChange, onEntries, onStatus, onDeleted }) {
  const state = { tally: null, url: '', entries: [], count: 0, clockOffset: 0, live: false, everLive: false };
  let events = null;
  let restartTimer;

  // Adds entries not seen before and reports them, oldest first, as one batch, along with
  // the total shown before them.
  function addAll(list) {
    const before = state.entries[0]?.total ?? 0;
    const known = new Set(state.entries.map((e) => e.id));
    const fresh = list.filter((e) => !known.has(e.id)).sort((a, b) => a.id - b.id);
    if (fresh.length) {
      state.entries.push(...fresh);
      state.entries.sort((a, b) => b.id - a.id); // newest first
      if (state.entries.length > MAX_ENTRIES) state.entries.length = MAX_ENTRIES;
      state.count += fresh.length;
    }
    onChange();
    if (fresh.length) onEntries?.(fresh, before);
  }

  function setLive(live) {
    state.live = live;
    if (live) state.everLive = true;
    onStatus?.();
  }

  function restart(delay) {
    events?.close();
    clearTimeout(restartTimer);
    restartTimer = setTimeout(start, delay);
  }

  function load(snap) {
    Object.assign(state, {
      tally: snap.tally,
      url: snap.url,
      entries: snap.entries,
      count: snap.count,
      clockOffset: snap.now - Date.now(),
    });
    listen(snap.entries[0]?.id ?? 0);
  }

  async function start() {
    try {
      const res = await fetch(`/api/tallies/${id}/snapshot`);
      if (res.status === 404) return onDeleted?.();
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      load(await res.json());
      onChange();
    } catch {
      setLive(false);
      restart(3000);
    }
  }

  function listen(after) {
    events = new EventSource(`/api/tallies/${id}/events?v=2&after=${after}`);
    events.addEventListener('entries', (e) => addAll(JSON.parse(e.data)));
    events.addEventListener('tally', (e) => {
      state.tally = JSON.parse(e.data);
      onChange();
    });
    // Away too long to catch up entry by entry: load the tally again.
    events.addEventListener('reset', () => restart(0));
    events.addEventListener('deleted', () => {
      events.close();
      onDeleted?.();
    });
    events.addEventListener('open', () => setLive(true));
    events.addEventListener('error', () => {
      setLive(false);
      // The browser retries by itself unless the server refused outright (deleted, or full).
      if (events.readyState === EventSource.CLOSED) restart(3000);
    });
  }

  // The page normally arrives with its snapshot; fetch it if it didn't.
  let snap = null;
  try {
    snap = JSON.parse(document.getElementById('snapshot').textContent);
  } catch {}
  if (snap) load(snap);
  else start();
  return { state, add: (entry) => addAll([entry]) };
}

export const serverNow = (state) => Date.now() + state.clockOffset;

// Per-person totals for the last 15 minutes. Undos and the changes they cancel are left out,
// since together they add nothing. People are told apart by device, so two "Sam"s stay separate.
export function recentPeople(state) {
  const now = serverNow(state);
  const since = now - RECENT_WINDOW;
  const undone = new Set(state.entries.map((e) => e.undoes).filter(Boolean));
  const people = new Map();
  for (const e of state.entries) {
    if (e.at < since) break;
    if (e.undoes || undone.has(e.id)) continue;
    const key = e.device || `name:${e.who}`;
    const p = people.get(key) ?? { key, device: e.device, who: e.who, changes: 0, net: 0, lastMinute: 0 };
    p.changes++;
    if (e.at >= now - 60_000) p.lastMinute++;
    p.net += e.delta;
    people.set(key, p);
  }
  const list = [...people.values()].sort((a, b) => b.net - a.net || b.changes - a.changes);
  const seen = new Map();
  for (const p of list) {
    const n = (seen.get(p.who) ?? 0) + 1;
    seen.set(p.who, n);
    p.label = n > 1 ? `${p.who} (${n})` : p.who;
    p.onFire = p.lastMinute >= 10;
  }
  // A crown needs a clear leader, not a tie or a lone counter.
  if (list.length > 1 && list[0].net > 0 && list[0].net > list[1].net) list[0].top = true;
  return list;
}

// A new entry that crosses a round hundred or reaches capacity is worth celebrating.
// Easter eggs, checked after capacity and every hundred.
const EGGS = new Map([
  [10, 'Double digits! \u{1F51F}'],
  [42, "42: don't panic"],
  [67, '6 7 \u{1F937}'],
  [167, '6 7 \u{1F937}'],
  [267, '6 7 \u{1F937}'],
  [367, '6 7 \u{1F937}'],
  [420, '4:20 \u{1F33F}'],
]);

// A count held at a round number by one-in-one-out crosses it again and again, so each
// milestone celebrates at most once per cool-down.
const COOLDOWN = 2 * 60_000;
const lastShown = new Map();

export function milestone(entry, capacity) {
  if (entry.delta <= 0) return null;
  const before = entry.total - entry.delta;
  let m = null;
  const hundreds = Math.floor(entry.total / 100);
  if (capacity && before < capacity && entry.total >= capacity) {
    m = { kind: 'capacity', at: 'capacity', text: 'Capacity reached' };
  } else if (entry.total >= 100 && hundreds > Math.floor(before / 100)) {
    m = { kind: 'hundred', at: hundreds * 100, text: (hundreds * 100).toLocaleString() };
  } else {
    // A batch can jump past a number, so count it if the total went over it.
    for (const [n, text] of EGGS) if (before < n && entry.total >= n) m = { kind: 'egg', at: n, text };
  }
  if (!m) return null;
  const now = Date.now();
  if (now - (lastShown.get(m.at) ?? -Infinity) < COOLDOWN) return null;
  lastShown.set(m.at, now);
  return m;
}

export function capacityState(total, capacity) {
  if (!capacity) return { level: '', text: '' };
  if (total > capacity) return { level: 'over', text: `${(total - capacity).toLocaleString()} over capacity of ${capacity.toLocaleString()}` };
  if (total === capacity) return { level: 'full', text: `At capacity (${capacity.toLocaleString()})` };
  return {
    level: total >= capacity * 0.9 ? 'near' : '',
    text: `of ${capacity.toLocaleString()} capacity`,
  };
}
