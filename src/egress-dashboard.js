// src/egress-dashboard.js — single-file dashboard for the egress pool.
// Served by GET /__egress/dashboard (routes.js → handleEgressDashboard).
// Talks to /__egress (state), /__egress/import, /__egress/toggle,
// /__egress/retest, /__egress/remove-user. No build step, no dependencies.

export function egressDashboardHtml() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>opencode-free-provider · egress</title>
<style>
  :root {
    --bg: #0b0e14; --panel: #131826; --line: #232b3f; --text: #d7e0f0;
    --dim: #8593ad; --ok: #3ddc84; --warn: #ffc857; --bad: #ff5d5d; --accent: #4d9fff;
  }
  * { box-sizing: border-box }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-monospace, "SFMono-Regular", Menlo, monospace }
  header { display: flex; align-items: center; gap: 12px; padding: 14px 18px; border-bottom: 1px solid var(--line); background: var(--panel); position: sticky; top: 0; z-index: 5 }
  header h1 { font-size: 15px; margin: 0; letter-spacing: .5px }
  .pill { padding: 2px 10px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; color: var(--dim) }
  .pill.ok { color: var(--ok); border-color: var(--ok) }
  main { padding: 16px 18px 60px; max-width: 1100px; margin: 0 auto }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 16px }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 12px 14px }
  .card .n { font-size: 24px; font-weight: 700 }
  .card .l { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .8px; margin-top: 2px }
  .card.ok .n { color: var(--ok) } .card.warn .n { color: var(--warn) } .card.bad .n { color: var(--bad) }
  .best { grid-column: 1 / -1; font-size: 13px; color: var(--dim) }
  .best b { color: var(--ok) }
  section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px; margin-bottom: 14px }
  section h2 { font-size: 12px; color: var(--dim); text-transform: uppercase; letter-spacing: 1px; margin: 0 0 10px }
  table { width: 100%; border-collapse: collapse; font-size: 13px }
  td, th { padding: 6px 8px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: middle }
  th { color: var(--dim); font-size: 11px; text-transform: uppercase; letter-spacing: .6px }
  .tag { display: inline-block; min-width: 56px; text-align: center; padding: 1px 8px; border-radius: 6px; font-size: 11px; font-weight: 700 }
  .tag.ok { background: rgba(61,220,132,.15); color: var(--ok) }
  .tag.untested { background: rgba(133,147,173,.15); color: var(--dim) }
  .tag.quota { background: rgba(255,200,87,.15); color: var(--warn) }
  .tag.dead { background: rgba(255,93,93,.15); color: var(--bad) }
  .tag.user { background: rgba(77,159,255,.18); color: var(--accent) }
  button { cursor: pointer; background: #1b2334; color: var(--text); border: 1px solid var(--line); border-radius: 7px; padding: 4px 10px; font: inherit; font-size: 12px }
  button:hover { background: #232d44 }
  button.on { border-color: var(--ok); color: var(--ok) }
  button.act { border-color: var(--accent); color: var(--accent) }
  input[type=checkbox].sw { appearance: none; width: 34px; height: 19px; border-radius: 999px; background: #2a3450; position: relative; cursor: pointer; display: inline-block; margin: 0 }
  input[type=checkbox].sw::after { content: ""; position: absolute; width: 15px; height: 15px; border-radius: 50%; background: var(--dim); top: 2px; left: 3px; transition: all .15s }
  input[type=checkbox].sw:checked { background: rgba(61,220,132,.3) }
  input[type=checkbox].sw:checked::after { left: 16px; background: var(--ok) }
  .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: flex-end }
  label.f { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--dim); flex: 1 1 260px }
  input[type=text], textarea { background: #0e1422; border: 1px solid var(--line); color: var(--text); border-radius: 7px; padding: 7px 10px; font: inherit; width: 100% }
  textarea { min-height: 70px; resize: vertical }
  .hint { color: var(--dim); font-size: 11px; margin-top: 6px }
  .msg { margin-top: 8px; font-size: 12px; color: var(--dim); min-height: 16px }
  .msg.good { color: var(--ok) } .msg.bad { color: var(--bad) }
  .due { color: var(--warn) }
  .spin { animation: spin 1s linear infinite; display: inline-block }
  @keyframes spin { to { transform: rotate(360deg) } }
</style>
</head>
<body>
<header>
  <h1>egress · opencode-free-provider</h1>
  <span class="pill" id="pill">…</span>
  <span class="pill" id="sweep"></span>
  <span style="flex:1"></span>
  <button onclick="refresh()">↻ refresh</button>
</header>
<main>
  <div class="cards" id="cards"></div>

  <section>
    <h2>My proxies (preferred in rotation, never auto-culled)</h2>
    <table id="userTable"><thead><tr><th></th><th>proxy</th><th>status</th><th>ttfb</th><th></th></tr></thead><tbody></tbody></table>
    <div class="hint">User-added proxies rotate before scraped ones and survive sweeper culling.</div>
  </section>

  <section>
    <h2>Add proxies</h2>
    <div class="row">
      <label class="f">Paste (one per line: ip:port or http://ip:port)
        <textarea id="addText" placeholder="203.0.113.7:3128&#10;http://198.51.100.2:8080&#10;10.1.2.3:443"></textarea>
      </label>
      <div style="display:flex;flex-direction:column;gap:6px;min-width:190px">
        <button class="act" onclick="doImport()">add + test</button>
        <input type="file" id="addFile" multiple accept=".txt,.list,.json,text/plain">
        <button onclick="doFile()">import file + test</button>
      </div>
    </div>
    <div class="msg" id="importMsg"></div>
  </section>

  <section>
    <h2>Pool</h2>
    <table id="poolTable"><thead><tr><th>on</th><th>proxy</th><th>status</th><th>ttfb</th><th>ok</th><th>src</th><th>actions</th></tr></thead><tbody></tbody></table>
  </section>

  <section>
    <h2>Dustbin</h2>
    <table id="dustTable"><thead><tr><th>proxy</th><th>reason</th><th>detail</th><th>retest due</th><th>actions</th></tr></thead><tbody></tbody></table>
  </section>
</main>

<script>
const $ = (s) => document.querySelector(s);
const api = (path, opts) => fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });

async function refresh() {
  const j = await (await fetch('/__egress')).json();
  const e = j.egress;
  renderCards(e);
  // full state comes from /__egress + the table payloads below
  const state = await fetch('/__egress/full').then(r => r.ok ? r.json() : null);
  const pools = state?.pool || e.top || [];
  renderUser(state?.user || []);
  renderPool(pools, state?.disabled || []);
  renderDust(state?.dustbin || [], e.dustbin);
  document.title = \`egress · ok \${e.ok} · user \${(state?.user||[]).length}\`;
}

function renderCards(e) {
  const cards = [
    { n: e.poolSize, l: 'pool', c: '' },
    { n: e.ok, l: 'verified ok', c: e.ok ? 'ok' : 'bad' },
    { n: e.untested, l: 'untested', c: 'warn' },
    { n: e.dustbinQuota, l: 'dustbin quota', c: 'warn' },
    { n: e.dustbinDead, l: 'dustbin dead', c: '' },
  ];
  $('#cards').innerHTML = cards.map(c => \`<div class="card \${c.c}"><div class="n">\${c.n}</div><div class="l">\${c.l}</div></div>\`).join('')
    + \`<div class="best">best egress: \${e.best ? '<b>' + e.best + '</b>' : '<span style="color:var(--bad)">none — direct connection in use</span>'}</div>\`;
  const p = $('#pill'); p.textContent = e.best ? 'ROUTES VIA PROXY' : 'DIRECT ONLY'; p.className = 'pill ' + (e.best ? 'ok' : '');
  const ls = e.lastSweep;
  $('#sweep').textContent = ls ? \`last sweep \${new Date(ls.at).toLocaleTimeString()}: ok \${ls.ok}/\${ls.tested}\` : 'no sweep yet';
}

function rowBtns(p, on, user) {
  let h = '<td><input type="checkbox" class="sw" ' + (on ? 'checked' : '') + ' onchange="toggle(\\'' + p + '\\', this.checked)"></td>';
  h += '<td>' + p + '</td><td data-status="' + p + '"><span class="tag untested">…</span></td>';
  h += '<td data-ttfb="' + p + '">—</td>';
  if (user) h += '<td><button onclick="retest(\\'' + p + '\\')">test</button> <button onclick="removeUser(\\'' + p + '\\')">✕</button></td>';
  else h += '<td><button onclick="retest(\\'' + p + '\\')">test</button></td>';
  return h;
}

function renderUser(user) {
  const tb = $('#userTable tbody');
  tb.innerHTML = user.length ? user.map(e => {
    const p = e.proxy;
    return '<tr>' + rowBtns(p, !e.disabled, true)
      .replace('<td>' + p + '</td>', '<td><span class="tag user">mine</span> ' + p + '</td>', 1) + '</tr>';
  }).join('') : '<tr><td colspan="5" style="color:var(--dim)">none yet — add yours below (paste or file); they rotate before scraped IPs</td></tr>';
  paintTags(user.map(e => e.proxy));
}

function renderPool(pool, disabled) {
  const tb = $('#poolTable tbody');
  const rows = (pool || []).slice().sort((a, b) => {
    const au = (a.source === 'user' ? 0 : 1), bu = (b.source === 'user' ? 0 : 1);
    if (au !== bu) return au - bu;
    return (a.ttfbMs || 9e9) - (b.ttfbMs || 9e9);
  }).slice(0, 400);
  tb.innerHTML = rows.length ? rows.map(e => '<tr>' + rowBtns(e.proxy, !disabled.includes(e.proxy), e.source === 'user')
    .replace('<td data-status="' + e.proxy + '"><span class="tag untested">…</span></td>', '<td data-status="' + e.proxy + '"><span class="tag ' + e.status + '">' + e.status + '</span></td>')
    .replace('<td data-ttfb="' + e.proxy + '">—</td>', '<td data-ttfb="' + e.proxy + '">' + (e.ttfbMs || '—') + '</td>')
    .replace('ok</td>', 'ok</td>') + '</tr>').join('')
    : '<tr><td colspan="7" style="color:var(--dim)">empty — waiting on sweeps</td></tr>';
  paintTags(rows.map(e => e.proxy));
}

function renderDust(dust, total) {
  const tb = $('#dustTable tbody');
  const rows = (dust || []).slice(0, 100);
  tb.innerHTML = rows.length ? rows.map(d => {
    const due = new Date(d.retestAt);
    const soon = due - Date.now() < 60000;
    return '<tr><td>' + d.proxy + '</td><td><span class="tag ' + d.reason + '">' + d.reason + '</span></td><td style="color:var(--dim)">' + (d.detail || '') + '</td>'
      + '<td class="' + (soon ? 'due' : '') + '">' + due.toLocaleString() + (soon ? ' ⏳' : '') + '</td>'
      + '<td><button class="act" onclick="retest(\\'' + d.proxy + '\\')">retest now</button></td></tr>';
  }).join('') : '<tr><td colspan="5" style="color:var(--dim)">dustbin empty</td></tr>';
  if (total > 100) tb.insertAdjacentHTML('beforeend', '<tr><td colspan="5" style="color:var(--dim)">… ' + total + ' total (showing 100)</td></tr>');
}

function paintTags(proxies) {
  (proxies || []).forEach(p => {
    const cell = document.querySelector('[data-status="' + CSS.escape(p) + '"]');
    if (!cell || cell.dataset.filled) return;
    cell.dataset.filled = '1'; // leave it as-is; refreshed on next full refresh
  });
}

async function toggle(p, on) {
  await api('/__egress/toggle', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  refresh();
}

async function retest(p) {
  const btns = [...document.querySelectorAll('button')].filter(b => b.textContent === 'test' && b.parentElement.textContent.includes(p));
  btns.forEach(b => { b.textContent = '⟳'; b.classList.add('spin') });
  const r = await api('/__egress/retest', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  const j = await r.json();
  if (!r.ok) { alert('retest failed: ' + JSON.stringify(j)); return; }
  refresh();
  const cell = document.querySelector('[data-status="' + CSS.escape(p) + '"]');
  if (cell) {
    cell.innerHTML = '<span class="tag ' + j.status + '">' + j.status + (j.retryAfterSec ? ' ' + Math.round(j.retryAfterSec / 60) + 'm' : '') + '</span>';
    cell.dataset.filled = '';
  }
  if (j.status === 'ok') flash('good', '✓ ' + p + ' verified ok');
  else flash(j.status === 'quota' ? 'warn' : 'bad', '✗ ' + p + ': ' + j.status + (j.detail ? ' (' + j.detail + ')' : ''));
}

async function removeUser(p) {
  await api('/__egress/remove-user', { method: 'POST', body: JSON.stringify({ proxy: p }) });
  refresh();
}

function flash(kind, text) {
  const m = $('#importMsg');
  m.textContent = text;
  m.className = 'msg ' + kind;
  clearTimeout(m._t); m._t = setTimeout(() => { m.textContent = ''; }, 6000);
}

async function doImport() {
  const text = $('#addText').value.trim();
  if (!text) return;
  $('#importMsg').textContent = 'adding + testing…'; $('#importMsg').className = 'msg';
  const r = await api('/__egress/import', { method: 'POST', body: text });
  const j = await r.json();
  const oks = (j.results || []).filter(x => x.status === 'ok');
  flash(oks.length ? 'good' : 'bad', 'added ' + j.added + ', ok ' + oks.length + (j.invalid?.length ? ', invalid ' + j.invalid.length : '') +
    (oks.length ? ' → ' + oks.map(x => x.proxy).join(', ') : ''));
  if (j.added) $('#addText').value = '';
  refresh();
}

async function doFile() {
  const files = [...$('#addFile').files];
  if (!files.length) return;
  let text = '';
  for (const f of files) text += (await f.text()) + '\\n';
  $('#importMsg').textContent = 'importing ' + files.length + ' file(s) + testing…'; $('#importMsg').className = 'msg';
  const r = await api('/__egress/import', { method: 'POST', body: text });
  const j = await r.json();
  const oks = (j.results || []).filter(x => x.status === 'ok');
  flash(oks.length ? 'good' : 'bad', files.map(f => f.name).join(', ') + ': added ' + j.added + ', ok ' + oks.length +
    (j.invalid?.length ? ', invalid ' + j.invalid.length : ''));
  $('#addFile').value = '';
  refresh();
}

setInterval(refresh, 15000);
refresh();
</script>
</body>
</html>
`;
}
