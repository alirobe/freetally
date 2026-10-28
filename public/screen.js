import { connect, statusText, fmtDelta, recentPeople, capacityState, milestone, visitorsText } from '/live.js';
import { celebrate, odometer, setSound, tick, chime } from '/fx.js';

const id = location.pathname.split('/')[2];
const $ = (sel) => document.querySelector(sel);
const setTotal = odometer($('#total'));

const live = connect(id, {
  onChange: render,
  onEntries(batch, before) {
    const total = live.state.entries[0]?.total ?? 0;
    tick(total >= before);
    const m = milestone({ delta: total - before, total }, live.state.tally?.capacity);
    if (m) {
      celebrate(m);
      chime(m.kind);
    }
  },
  onStatus: renderStatus,
  onDeleted: () => location.reload(),
});

function render() {
  const { tally, entries } = live.state;
  if (tally) {
    $('#title').textContent = tally.name;
    document.title = `${tally.name} - FreeTally`;
  }
  const total = entries[0]?.total ?? 0;
  setTotal(total);
  const cap = capacityState(total, tally?.capacity);
  $('#capacity').textContent = cap.text;
  $('#total-box').dataset.level = cap.level;
  $('#visitors').textContent = visitorsText(entries[0]?.visitors ?? 0);
  renderRecent();
  renderStatus();
}

function renderRecent() {
  const people = recentPeople(live.state);
  const net = people.reduce((sum, p) => sum + p.net, 0);
  $('#recent').textContent = people.length
    ? `${net ? fmtDelta(net) : 'No change'} in the last 15 minutes`
    : 'No counting in the last 15 minutes';
}

function renderStatus() {
  const closed = live.state.tally?.closedAt;
  const el = $('#status');
  el.textContent = statusText(live.state, !live.state.live, closed);
  el.classList.toggle('off', Boolean(closed) || !live.state.live);
}

render();
setInterval(renderRecent, 30_000);

$('#sound').addEventListener('click', async (e) => {
  const on = e.currentTarget.getAttribute('aria-pressed') !== 'true';
  try {
    await setSound(on);
    e.currentTarget.setAttribute('aria-pressed', String(on));
    e.currentTarget.textContent = on ? 'Sound on' : 'Sound off';
  } catch {}
});

// A display left on a wall shouldn't go to sleep.
async function keepAwake() {
  if (document.visibilityState !== 'visible' || !('wakeLock' in navigator)) return;
  try {
    await navigator.wakeLock.request('screen');
  } catch {}
}
document.addEventListener('visibilitychange', keepAwake);
keepAwake();
