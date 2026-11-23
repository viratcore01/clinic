// Verify recover-anywhere.js against the copied Chrome profile.
// Usage: bun scripts/verify-recover.mjs <port>
import { readFileSync } from 'node:fs';

const port = process.argv[2] || '9333';
const script = readFileSync(new URL('../recover-anywhere.js', import.meta.url), 'utf8');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
const send = (method, params = {}) => new Promise((res) => {
  const myId = ++id; pending.set(myId, res); ws.send(JSON.stringify({ id: myId, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  return r.result && r.result.result ? r.result.result.value : undefined;
};

await send('Page.enable');
await send('Runtime.enable');
await send('Page.navigate', { url: 'https://clinic-ochre-seven.vercel.app/robots.txt' });
await sleep(3500);

// Plant a patient under a key the old snippet never looked at.
await evaluate(`localStorage.setItem('zz_unknown_patient_list', JSON.stringify([{ name: 'Verification Patient', mobile: '9000000001', registration: 'TEST-0001' }])); true`);

const payload = await evaluate(script);
const names = (payload?.rows || []).map((r) => r.name);
console.log('count:', payload?.count);
console.log('server:', JSON.stringify(payload?.server));
console.log('planted record found:', names.includes('Verification Patient'));
console.log('first three:', JSON.stringify((payload?.rows || []).slice(0, 3).map((r) => ({ name: r.name, reg: r.reg }))));

await evaluate(`localStorage.removeItem('zz_unknown_patient_list'); true`);
ws.close();
