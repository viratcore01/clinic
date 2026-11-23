/*
 * CLINIC RECOVERY — paste this whole file into the browser console
 * (F12 → Console) on the clinic address the records were entered on.
 *
 * It reads, read-only:
 *   - every key in localStorage and sessionStorage (not just known ones)
 *   - every IndexedDB database and object store
 *   - every Cache Storage entry
 *   - the server copy at /api/patients + /api/notes when the page is signed in
 *
 * It then downloads one JSON file and prints a summary. It never writes to,
 * edits or deletes anything in the browser or on the server.
 */
(async () => {
  'use strict';

  var rows = new Map();

  function text(v) { return v == null ? '' : String(v); }
  function norm(v) { return text(v).toLowerCase().replace(/[^a-z0-9]/g, ''); }
  function digits(v) { return text(v).replace(/\D/g, ''); }

  function addRow(r) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) return;
    var row = Object.assign({}, (r.meta && typeof r.meta === 'object') ? r.meta : {}, r);
    delete row.meta;

    row.name = row.name || row.patientName || row.fullName || row.patient || row.clientName || '';
    row.phone = row.phone || row.mobile || row.contact || row.phoneNumber || row.mobileNumber || '';
    row.reg = row.reg || row.registration || row.registrationNumber || row.regNo || row.registration_no || '';
    if (!row.notes && row.seed_notes) row.notes = row.seed_notes;
    if (!row.reg && row.id != null && !/^\d+$/.test(text(row.id).trim())) row.reg = text(row.id).trim();
    if (!row.name || (!row.phone && !row.reg)) return;

    row.name = text(row.name).trim();
    row.phone = text(row.phone).trim();
    row.reg = text(row.reg).trim();

    var key = norm(row.reg) || digits(row.phone) || norm(row.name);
    if (!key) return;

    if (rows.has(key)) {
      var kept = rows.get(key);
      if (!kept.notes && row.notes) kept.notes = row.notes;
      if (!kept.phone && row.phone) kept.phone = row.phone;
      return;
    }
    rows.set(key, row);
  }

  function walk(value, depth) {
    if (value == null || depth > 7) return;
    if (Array.isArray(value)) { for (var i = 0; i < value.length; i++) walk(value[i], depth + 1); return; }
    if (typeof value !== 'object') return;
    addRow(value);
    for (var k in value) { if (k === 'meta') continue; walk(value[k], depth + 1); }
  }

  function walkJSON(raw) {
    if (!raw) return;
    var t = text(raw).trim();
    if (t.charAt(0) !== '{' && t.charAt(0) !== '[') return;
    try { walk(JSON.parse(t), 0); } catch (e) {}
  }

  // 1. Every key in both web storages.
  [localStorage, sessionStorage].forEach(function (store) {
    try {
      for (var i = 0; i < store.length; i++) walkJSON(store.getItem(store.key(i)));
    } catch (e) {}
  });

  // 2. Every IndexedDB database and store.
  var dbNames = [];
  try {
    var infos = indexedDB.databases ? await indexedDB.databases() : [];
    for (var d = 0; d < infos.length; d++) if (infos[d] && infos[d].name) dbNames.push(infos[d].name);
  } catch (e) {}

  for (var n = 0; n < dbNames.length; n++) {
    var name = dbNames[n];
    var db = await new Promise(function (res) {
      var req;
      try { req = indexedDB.open(name); } catch (e) { return res(null); }
      var timer = setTimeout(function () { res(null); }, 4000);
      req.onsuccess = function () { clearTimeout(timer); res(req.result); };
      req.onerror = function () { clearTimeout(timer); res(null); };
      req.onblocked = function () { clearTimeout(timer); res(null); };
    });
    if (!db) continue;
    try {
      var stores = Array.prototype.slice.call(db.objectStoreNames);
      for (var s = 0; s < stores.length; s++) {
        var values = await new Promise(function (res) {
          try {
            var q = db.transaction(stores[s], 'readonly').objectStore(stores[s]).getAll();
            q.onsuccess = function () { res(q.result || []); };
            q.onerror = function () { res([]); };
          } catch (e) { res([]); }
        });
        for (var v = 0; v < values.length; v++) walk(values[v], 0);
      }
    } finally { try { db.close(); } catch (e) {} }
  }

  // 3. Cache Storage.
  try {
    var cacheNames = await caches.keys();
    for (var c = 0; c < cacheNames.length; c++) {
      var cache = await caches.open(cacheNames[c]);
      var reqs = await cache.keys();
      for (var q2 = 0; q2 < reqs.length; q2++) {
        var resp = await cache.match(reqs[q2]);
        if (resp) walkJSON(await resp.text());
      }
    }
  } catch (e) {}

  // 4. The signed-in server copy (works on the Vitalis deployment).
  var server = { reached: false, signedIn: false, patients: 0, notes: 0 };
  try {
    var pr = await fetch('/api/patients', { cache: 'no-store' });
    server.reached = true;
    if (pr.ok) {
      server.signedIn = true;
      var pj = await pr.json().catch(function () { return {}; });
      var list = Array.isArray(pj.patients) ? pj.patients : [];
      server.patients = list.length;
      list.forEach(addRow);
      var nr = await fetch('/api/notes', { cache: 'no-store' });
      if (nr.ok) {
        var nj = await nr.json().catch(function () { return {}; });
        var notes = nj.notes || {};
        server.notes = Object.keys(notes).length;
        rows.forEach(function (row) {
          var body = notes[row.reg] || notes[row.registrationNumber];
          if (body && !row.notes) row.notes = body;
        });
      }
    }
  } catch (e) {}

  var out = [];
  rows.forEach(function (r) { out.push(r); });
  out.sort(function (a, b) { return text(a.reg).localeCompare(text(b.reg)); });

  var payload = {
    app: 'clinic-patient-directory',
    version: 2,
    source: 'device-recovery-anywhere',
    takenAt: new Date().toISOString(),
    origin: location.origin,
    device: navigator.userAgent,
    count: out.length,
    server: server,
    rows: out,
    tombstones: {},
    seeded: true
  };

  try {
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'clinic-recovered-' + location.host.replace(/[^a-z0-9.-]/gi, '_') + '-' + new Date().toISOString().slice(0, 10) + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
  } catch (e) {
    console.log('[clinic recovery] could not auto-download, run: copy(JSON.stringify(window.__clinicRecovery, null, 2))');
  }

  window.__clinicRecovery = payload;
  console.log('[clinic recovery] ' + out.length + ' records from ' + location.origin, server);
  try { console.table(out.map(function (r) { return { name: r.name, phone: r.phone, reg: r.reg }; })); } catch (e) {}
  return payload;
})();
