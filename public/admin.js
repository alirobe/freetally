const key = location.pathname.split('/').pop();
const api = `/api/admin/${key}/tallies`;
const $ = (sel) => document.querySelector(sel);

const fmtDate = (ms) =>
  ms ? new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '-';

function showError(message) {
  $('#error').textContent = message;
  $('#error').hidden = !message;
}

function cell(text, cls) {
  const td = document.createElement('td');
  if (cls) td.className = cls;
  td.textContent = text;
  return td;
}

async function remove(t, button) {
  if (!confirm(`Delete "${t.name}" and all ${t.changes.toLocaleString()} changes? This can't be undone.`)) return;
  button.disabled = true;
  try {
    const res = await fetch(`${api}/${t.id}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await load();
  } catch (err) {
    showError(`Couldn't delete "${t.name}": ${err.message}`);
    button.disabled = false;
  }
}

async function setClosed(t, button) {
  button.disabled = true;
  try {
    const res = await fetch(`${api}/${t.id}/${t.closedAt ? 'reopen' : 'close'}`, { method: 'POST' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
    await load();
  } catch (err) {
    showError(`Couldn't update "${t.name}": ${err.message}`);
    button.disabled = false;
  }
}

async function ownerLink(t, button) {
  if (!confirm(`Make a new owner link for "${t.name}"? Whoever can edit it now will lose that, until they open the new link.`)) return;
  button.disabled = true;
  try {
    const res = await fetch(`${api}/${t.id}/owner-key`, { method: 'POST' });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
    showError('');
    $('#owner-link-heading').textContent = `Owner link for "${t.name}"`;
    $('#owner-link-url').value = body.url;
    $('#owner-link').hidden = false;
    $('#owner-link-url').select();
  } catch (err) {
    showError(`Couldn't make an owner link for "${t.name}": ${err.message}`);
  } finally {
    button.disabled = false;
  }
}

$('#owner-link-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('#owner-link-url').value);
    $('#owner-link-copy').textContent = 'Copied';
    setTimeout(() => ($('#owner-link-copy').textContent = 'Copy'), 1500);
  } catch {
    $('#owner-link-url').select();
  }
});
$('#owner-link-url').addEventListener('focus', (e) => e.target.select());
$('#owner-link-close').addEventListener('click', () => {
  $('#owner-link').hidden = true;
  $('#owner-link-url').value = '';
});

function action(label, onClick, className = '') {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.className = className;
  button.addEventListener('click', () => onClick(button));
  return button;
}

async function load() {
  try {
    const res = await fetch(api);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const tallies = await res.json();
    showError('');
    $('#summary').textContent = `${tallies.length} ${tallies.length === 1 ? 'tally' : 'tallies'}`;
    $('#tallies').hidden = !tallies.length;
    $('#tallies tbody').replaceChildren(
      ...tallies.map((t) => {
        const tr = document.createElement('tr');
        const name = document.createElement('td');
        const a = document.createElement('a');
        a.href = `/t/${t.id}`;
        a.textContent = t.name;
        name.append(a);
        if (t.closedAt) {
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = 'Closed';
          name.append(' ', tag);
        }
        const actionsCell = document.createElement('td');
        const actions = document.createElement('div');
        actions.className = 'actions';
        actionsCell.append(actions);
        const csv = document.createElement('a');
        csv.href = `${api}/${t.id}/export.csv`;
        csv.textContent = 'CSV';
        const log = document.createElement('a');
        log.href = `${api}/${t.id}/log.csv`;
        log.textContent = 'Log';
        actions.append(
          action(t.closedAt ? 'Reopen' : 'Close', (b) => setClosed(t, b)),
          action('Owner link', (b) => ownerLink(t, b)),
          csv,
          log,
          action('Delete', (b) => remove(t, b), 'danger'),
        );
        tr.append(
          name,
          cell(t.capacity ? `${t.total.toLocaleString()} / ${t.capacity.toLocaleString()}` : t.total.toLocaleString(), 'num'),
          cell(t.visitors.toLocaleString(), 'num'),
          cell(t.changes.toLocaleString(), 'num'),
          cell(t.people.toLocaleString(), 'num'),
          cell(fmtDate(t.lastAt)),
          cell(fmtDate(t.createdAt)),
          actionsCell,
        );
        return tr;
      }),
    );
  } catch (err) {
    showError(`Couldn't load tallies: ${err.message}`);
  }
}

load();
