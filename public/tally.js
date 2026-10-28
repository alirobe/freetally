import { connect, statusText, fmtDelta, recentPeople, capacityState, milestone, visitorsText } from '/live.js';
import { bump, floatFrom, celebrate } from '/fx.js';

const id = location.pathname.split('/').pop();
const $ = (sel) => document.querySelector(sel);

const NAME_KEY = 'freetally:name';
const DEVICE_KEY = 'freetally:device';
const RECENT_KEY = 'freetally:recent';
// Taps wait here until the server confirms them, so a flaky connection or a reload doesn't lose any.
const QUEUE_KEY = `freetally:queue:${id}`;
const OWNER_KEY = `freetally:owner:${id}`;
const HISTORY_PREVIEW = 3;
const UNDO_SECONDS = 10;

function load(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

// crypto.randomUUID needs HTTPS; this works on a plain-HTTP LAN address too.
const randomHex = (bytes) =>
  Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, '0')).join('');

let device = load(DEVICE_KEY, '');
if (!device) {
  device = randomHex(16);
  save(DEVICE_KEY, device);
}

let name = load(NAME_KEY, '');
let queue = load(QUEUE_KEY, []);
let flushing = false;
let retryTimer;
let showAllHistory = false;
let undoTarget = null;
let undoTimer;
let duplicateOk = '';
// tally.html's inline script saves an owner link's key; the address keeps it only if storage is blocked.
let ownerKey = load(OWNER_KEY, '') || (/[#&]owner=([A-Za-z0-9_-]+)/.exec(location.hash)?.[1] ?? '');

const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });
// Entries carry the first 8 characters of the device id; anything shorter isn't one of ours.
const isMyDevice = (d) => d?.length >= 8 && device.startsWith(d);
const isMine = (e) => (e.device ? isMyDevice(e.device) : e.who === name);
const closed = () => Boolean(live.state.tally?.closedAt);

const live = connect(id, {
  onChange: render,
  onEntries(batch, before) {
    const total = live.state.entries[0]?.total ?? 0;
    if (total !== before) bump($('#total'), total > before);
    // Your own taps already floated from the button; show everyone else's as one number.
    const others = batch.filter((e) => !isMine(e)).reduce((sum, e) => sum + e.delta, 0);
    if (others) floatFrom($('#total'), fmtDelta(others), others > 0);
    const m = milestone({ delta: total - before, total }, live.state.tally?.capacity);
    if (m) celebrate(m);
  },
  onStatus() {
    renderStatus();
    if (live.state.live) flush();
  },
  onDeleted() {
    clearTimeout(retryTimer);
    save(QUEUE_KEY, []);
    save(RECENT_KEY, load(RECENT_KEY, []).filter((t) => t.id !== id));
    location.reload();
  },
});

// Errors appear over the page, like the undo prompt, so nothing below them moves.
let errorTimer;
function showError(message) {
  clearTimeout(errorTimer);
  $('#error-toast').textContent = message;
  $('#error-toast').hidden = !message;
  if (message) errorTimer = setTimeout(() => ($('#error-toast').hidden = true), 5000);
}

function renderStatus() {
  const el = $('#status');
  const offline = !navigator.onLine || !live.state.live;
  el.textContent = statusText(live.state, offline);
  el.classList.toggle('off', offline);
}

// The buttons always keep their place. The line above them says who is counting, asks for a
// name, or says counting has closed; when closed, the buttons are disabled rather than removed.
function renderControls() {
  const isClosed = closed();
  $('#who').textContent = name;
  $('#who-named').hidden = !name || isClosed;
  $('#who-unnamed').hidden = Boolean(name) || isClosed;
  $('#who-closed').hidden = !isClosed;
  if (isClosed) {
    $('#who-closed').textContent = `Counting closed at ${fmtTime(live.state.tally.closedAt)}.`;
    hideUndo();
  }
  for (const el of $('#controls').querySelectorAll('.quick button, #adjust button, #adjust input')) el.disabled = isClosed;
  updateWakeLock();
}

let rememberedTally = '';

function render() {
  const { tally, entries, url } = live.state;
  if (tally) {
    $('#title').textContent = tally.name;
    document.title = `${tally.name} - FreeTally`;
    $('#link').value = url;
    if (!$('#qr').src) $('#qr').src = `/api/tallies/${id}/qr.svg`;
    if (rememberedTally !== tally.name) {
      rememberedTally = tally.name;
      remember(tally);
    }
  }

  const total = entries[0]?.total ?? 0;
  $('#total').textContent = total.toLocaleString();
  const cap = capacityState(total, tally?.capacity);
  $('#capacity').textContent = cap.text;
  $('#total-box').dataset.level = cap.level;
  $('#visitors').textContent = visitorsText(entries[0]?.visitors ?? 0);

  // A tap normally confirms in a fraction of a second; only mention ones that are stuck.
  const stuck = queue.length && (!navigator.onLine || !live.state.live || Date.now() - queue[0].tappedAt > 1000);
  const pendingSum = queue.reduce((sum, op) => sum + op.delta, 0);
  $('#pending').textContent = stuck ? `${fmtDelta(pendingSum)} not sent yet` : '';

  $('#edit-open').hidden = !ownerKey;
  renderControls();
  renderPeople();
  renderHistory();
}

function renderPeople() {
  const list = recentPeople(live.state);
  const net = list.reduce((sum, p) => sum + p.net, 0);
  $('#recent-summary').textContent = list.length
    ? `${net ? fmtDelta(net) : 'No change'} from ${list.length} ${list.length === 1 ? 'person' : 'people'}`
    : 'No counting in the last 15 minutes.';
  $('#people').replaceChildren(
    ...list.map((p) =>
      row(isMyDevice(p.device) ? 'mine' : '', [
        ['name', `${p.top ? '\u{1F451} ' : ''}${p.label}${p.onFire ? ' \u{1F525}' : ''}`],
        ['changes', `${p.changes} ${p.changes === 1 ? 'change' : 'changes'}`],
        ['net', p.net ? fmtDelta(p.net) : '0'],
      ]),
    ),
  );
}

// One row per person per second, so a burst of taps reads as one change. Undos and the taps they
// undid keep their own rows.
function historyRows(entries, undone) {
  const rows = [];
  const groups = new Map();
  for (const e of entries) {
    const single = e.undoes || undone.has(e.id);
    const key = `${Math.floor(e.at / 1000)}:${e.device || e.who}`;
    const group = !single && groups.get(key);
    if (group) {
      group.delta += e.delta;
      continue;
    }
    const r = { ...e };
    rows.push(r);
    if (!single) groups.set(key, r);
  }
  return rows;
}

function renderHistory() {
  const { entries, count } = live.state;
  const undone = new Set(entries.map((e) => e.undoes).filter(Boolean));
  const rows = historyRows(entries, undone);
  const shown = showAllHistory ? rows : rows.slice(0, HISTORY_PREVIEW);
  $('#history').replaceChildren(
    ...shown.map((e) => {
      const classes = [e.delta >= 0 ? 'up' : 'down'];
      if (isMine(e)) classes.push('mine');
      if (undone.has(e.id)) classes.push('undone');
      return row(classes.join(' '), [
        ['time', fmtTime(e.at)],
        ['who', e.undoes ? `${e.who} (undo)` : e.who],
        ['delta', e.delta ? fmtDelta(e.delta) : '0'],
        ['run', e.total.toLocaleString()],
      ]);
    }),
  );
  $('#empty').hidden = entries.length > 0;
  $('#history-toggle').hidden = rows.length <= HISTORY_PREVIEW;
  $('#history-toggle').textContent = showAllHistory ? 'Show fewer' : `Show all ${count.toLocaleString()} changes`;
  $('#history-note').hidden = !showAllHistory || count <= entries.length;
  $('#history-note').textContent = `Showing the latest ${entries.length.toLocaleString()} of ${count.toLocaleString()} changes.`;
}

function row(className, cells) {
  const li = document.createElement('li');
  li.className = className;
  for (const [cls, text] of cells) {
    const span = document.createElement('span');
    span.className = cls;
    span.textContent = text;
    li.append(span);
  }
  return li;
}

// Sending

async function flush() {
  if (flushing) return;
  flushing = true;
  clearTimeout(retryTimer);
  try {
    while (queue.length) {
      const op = queue[0];
      const res = await fetch(`/api/tallies/${id}/entries`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(op),
      });
      if (res.status === 429) {
        // Rate limited: keep the tap and send it shortly.
        showError('Slow down a little. Your taps will send in a moment.');
        throw new Error('rate limited');
      }
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      const body = await res.json().catch(() => ({}));
      queue.shift();
      save(QUEUE_KEY, queue);
      if (res.ok) {
        showError('');
        live.add(body);
        if (!body.undoes) offerUndo(body, op.tappedAt);
      } else {
        showError(`${fmtDelta(op.delta)} wasn't counted: ${body.error ?? 'rejected by the server'}`);
        render();
      }
    }
  } catch {
    retryTimer = setTimeout(flush, 3000);
  } finally {
    flushing = false;
  }
}

function add(delta, extra = {}) {
  if (!name) return openNameDialog();
  queue.push({ opId: randomHex(12), delta, who: name, device, tappedAt: Date.now(), ...extra });
  save(QUEUE_KEY, queue);
  navigator.vibrate?.(15);
  render();
  flush();
  setTimeout(render, 1100); // shows "not sent yet" if this tap is still waiting
}

// Undo

function offerUndo(entry, tappedAt = Date.now()) {
  const left = UNDO_SECONDS * 1000 - (Date.now() - tappedAt);
  if (left <= 0 || closed()) return;
  undoTarget = entry;
  $('#undo-text').textContent = `${fmtDelta(entry.delta)} counted`;
  $('#undo').hidden = false;
  clearTimeout(undoTimer);
  undoTimer = setTimeout(hideUndo, left);
}

function hideUndo() {
  undoTarget = null;
  $('#undo').hidden = true;
  clearTimeout(undoTimer);
}

$('#undo-button').addEventListener('click', () => {
  if (!undoTarget) return;
  add(-undoTarget.delta, { undoes: undoTarget.id });
  hideUndo();
});

// Keep the screen on while counting

let wakeLock = null;
let wakeLockPending = false;

async function updateWakeLock() {
  const want = Boolean(name) && !closed() && document.visibilityState === 'visible';
  if (want && !wakeLock && !wakeLockPending && 'wakeLock' in navigator) {
    wakeLockPending = true;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } catch {
      // Refused (battery saver, unsupported browser); counting still works.
    } finally {
      wakeLockPending = false;
    }
  } else if (!want && wakeLock) {
    wakeLock.release();
    wakeLock = null;
  }
}
document.addEventListener('visibilitychange', updateWakeLock);

// Editing, for the browser that started the tally

$('#edit-open').addEventListener('click', () => {
  const { tally } = live.state;
  if (!tally) return;
  $('#edit-name').value = tally.name;
  $('#edit-capacity').value = tally.capacity ?? '';
  $('#edit-error').hidden = true;
  $('#edit-dialog').showModal();
});
$('#edit-cancel').addEventListener('click', () => $('#edit-dialog').close());
$('#edit').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  try {
    const res = await fetch(`/api/tallies/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', 'x-owner-key': ownerKey },
      body: JSON.stringify({ name: $('#edit-name').value, capacity: $('#edit-capacity').value || null }),
    });
    const body = await res.json().catch(() => ({}));
    if (res.status === 403) {
      // The organiser has issued a new owner link, so this browser's key no longer works.
      ownerKey = '';
      try {
        localStorage.removeItem(OWNER_KEY);
      } catch {}
      render();
      throw new Error('This browser can no longer edit this tally. Ask the organiser for a new owner link.');
    }
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    live.state.tally = body;
    $('#edit-dialog').close();
    render();
  } catch (err) {
    $('#edit-error').textContent = err.message || "Couldn't save. Try again.";
    $('#edit-error').hidden = false;
  } finally {
    button.disabled = false;
  }
});

// Name

// The name is asked for in a dialog over the page, so the buttons below never move. It opens by
// itself on a first visit; someone just watching can close it, and a tap opens it again.
function openNameDialog() {
  if (closed() || $('#name-dialog').open) return;
  $('#name-input').value = name;
  $('#name-warning').hidden = true;
  duplicateOk = '';
  $('#name-dialog').showModal();
}

$('#name-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const value = $('#name-input').value.replace(/\s+/g, ' ').trim();
  if (!value) return;
  const taken = live.state.entries.some(
    (x) => x.device && !isMyDevice(x.device) && x.who.toLowerCase() === value.toLowerCase(),
  );
  if (taken && duplicateOk !== value) {
    duplicateOk = value;
    $('#name-warning').textContent = `Someone else is already counting as ${value}. Add something to tell you apart, like "${value} at the bar", or tap Start counting again to use it anyway.`;
    $('#name-warning').hidden = false;
    return;
  }
  name = value;
  save(NAME_KEY, name);
  $('#name-dialog').close();
  render();
});
$('#name-cancel').addEventListener('click', () => $('#name-dialog').close());
$('#rename').addEventListener('click', openNameDialog);
$('#name-open').addEventListener('click', openNameDialog);

// Counting

for (const button of document.querySelectorAll('[data-delta]')) {
  button.addEventListener('click', () => {
    const delta = Number(button.dataset.delta);
    floatFrom(button, fmtDelta(delta), delta > 0);
    add(delta);
  });
}
for (const button of document.querySelectorAll('[data-sign]')) {
  button.addEventListener('click', () => {
    const amount = Number($('#amount').value);
    if (!Number.isInteger(amount) || amount < 1) {
      showError('Enter a whole number above zero.');
      $('#amount').focus();
      return;
    }
    const delta = amount * Number(button.dataset.sign);
    floatFrom(button, fmtDelta(delta), delta > 0);
    add(delta);
    $('#amount').value = '';
  });
}
// Enter alone shouldn't guess between add and subtract.
$('#adjust').addEventListener('submit', (e) => e.preventDefault());

$('#history-toggle').addEventListener('click', () => {
  showAllHistory = !showAllHistory;
  renderHistory();
});
// The 15-minute window moves even when nobody is counting.
setInterval(renderPeople, 30_000);

addEventListener('online', () => {
  renderStatus();
  flush();
});
addEventListener('offline', renderStatus);

// Sharing

function remember(tally) {
  const recent = load(RECENT_KEY, []).filter((t) => t.id !== tally.id);
  recent.unshift({ id: tally.id, name: tally.name });
  save(RECENT_KEY, recent.slice(0, 10));
}

$('#screen-link').href = `/t/${id}/screen`;
$('#copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#link').value);
    $('#copy').textContent = 'Copied';
    setTimeout(() => ($('#copy').textContent = 'Copy'), 1500);
  } catch {
    $('#link').select();
  }
});
$('#link').addEventListener('focus', (e) => e.target.select());

if (location.search) history.replaceState(null, '', location.pathname);
// An owner link pasted into a tab already showing this tally only changes the hash; reload so the
// page saves the key the usual way.
addEventListener('hashchange', () => {
  if (/[#&]owner=/.test(location.hash)) location.reload();
});

renderStatus();
render();
if (!name) openNameDialog();
flush();
