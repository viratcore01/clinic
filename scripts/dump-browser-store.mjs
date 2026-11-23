/**
 * Read a copied Chrome profile's clinic origin storage through CDP.
 * Launch Chrome yourself with the copy, then run:  bun dump-browser-store.mjs <port> <outfile>
 */
const port = process.argv[2] || '9333';
const outFile = process.argv[3] || 'browser-store-dump.json';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  if (!page) throw new Error('no page target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const myId = ++id;
    pending.set(myId, res);
    ws.send(JSON.stringify({ id: myId, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Page.navigate', { url: 'https://clinic-ochre-seven.vercel.app/robots.txt' });
  await sleep(3500);

  const expr = `(async () => {
    const out = { origin: location.origin, localStorage: {}, sessionStorage: {}, databases: [], cacheNames: [] };
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); out.localStorage[k] = localStorage.getItem(k); } } catch (e) { out.lsError = String(e); }
    try { for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); out.sessionStorage[k] = sessionStorage.getItem(k); } } catch (e) {}
    try { out.cacheNames = await caches.keys(); } catch (e) {}
    const dbs = await indexedDB.databases();
    for (const info of dbs) {
      const db = await new Promise((res) => {
        let r; try { r = indexedDB.open(info.name); } catch (e) { return res(null); }
        r.onsuccess = () => res(r.result); r.onerror = () => res(null); r.onblocked = () => res(null);
        setTimeout(() => res(null), 3000);
      });
      if (!db) continue;
      const entry = { name: info.name, version: db.version, stores: {} };
      for (const s of Array.from(db.objectStoreNames)) {
        entry.stores[s] = await new Promise((res) => {
          try { const q = db.transaction(s, 'readonly').objectStore(s).getAll(); q.onsuccess = () => res(q.result); q.onerror = () => res([]); }
          catch (e) { res([]); }
        });
      }
      db.close();
      out.databases.push(entry);
    }
    return out;
  })()`;

  const result = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  const value = result && result.result && result.result.result && result.result.result.value;
  if (!value) {
    console.error(JSON.stringify(result).slice(0, 2000));
    process.exit(1);
  }
  await Bun.write(outFile, JSON.stringify(value));
  const counts = value.databases.map((d) => `${d.name}: ` + Object.entries(d.stores).map(([k, v]) => `${k}=${v.length}`).join(','));
  console.log('origin', value.origin);
  console.log('localStorage keys:', Object.keys(value.localStorage).join(', '));
  console.log('databases:', counts.join(' | '));
  ws.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
