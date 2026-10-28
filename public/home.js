const $ = (sel) => document.querySelector(sel);

let recent = [];
try {
  recent = JSON.parse(localStorage.getItem('freetally:recent')) ?? [];
} catch {}

if (recent.length) {
  for (const t of recent) {
    const li = document.createElement('li');
    const a = document.createElement('a');
    a.href = `/t/${t.id}`;
    a.textContent = t.name;
    li.append(a);
    $('#recent-list').append(li);
  }
  $('#recent').hidden = false;
}

$('#create').addEventListener('submit', async (e) => {
  e.preventDefault();
  const button = e.submitter;
  button.disabled = true;
  $('#error').hidden = true;
  try {
    const res = await fetch('/api/tallies', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: $('#name').value, capacity: $('#capacity').value || null }),
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    try {
      localStorage.setItem(`freetally:owner:${body.id}`, JSON.stringify(body.ownerKey));
    } catch {}
    location.href = `/t/${body.id}?new=1`;
  } catch (err) {
    $('#error').textContent = err.message || "Couldn't reach the server. Try again.";
    $('#error').hidden = false;
    button.disabled = false;
  }
});
