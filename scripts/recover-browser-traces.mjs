/**
 * Recover patient data that a browser kept outside the clinic app.
 *
 * The clinic page that was live between 19 Oct and 19 Nov 2026 never wrote to
 * disk: every save failed against a Supabase host that did not exist. But the
 * browser itself records values typed into forms (Chrome's `autofill` table)
 * and can keep page state in its session files. Those traces can outlive a
 * failed save.
 *
 * Read-only. It copies databases to a temp folder and never writes inside a
 * browser profile.
 *
 * Usage (Node 22+):
 *   node scripts/recover-browser-traces.mjs
 *   node scripts/recover-browser-traces.mjs --profile "C:\path\to\User Data\Default"
 *   node scripts/recover-browser-traces.mjs --out report.json
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i !== -1 ? args[i + 1] : null;
};
const outPath = argValue('--out') || 'browser-traces-report.json';
const explicitProfile = argValue('--profile');

const PROFILE_ROOTS = [
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Google/Chrome/User Data'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'Microsoft/Edge/User Data'),
  process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, 'BraveSoftware/Brave-Browser/User Data'),
  join(homedir(), 'Library/Application Support/Google/Chrome'),
  join(homedir(), 'Library/Application Support/Microsoft Edge'),
  join(homedir(), '.config/google-chrome'),
  join(homedir(), '.config/microsoft-edge')
].filter(Boolean);

function profilesFromRoot(root) {
  if (!existsSync(root)) return [];
  const out = [];
  for (const name of readdirSync(root)) {
    if (name !== 'Default' && !/^Profile \d+$/.test(name)) continue;
    const dir = join(root, name);
    if (existsSync(join(dir, 'Web Data')) || existsSync(join(dir, 'Sessions'))) {
      out.push({ browser: basename(root.split(/[\\/]/).slice(-2)[0] || root), profile: name, dir });
    }
  }
  return out;
}

const profiles = explicitProfile
  ? [{ browser: 'explicit', profile: basename(explicitProfile), dir: explicitProfile }]
  : PROFILE_ROOTS.flatMap(profilesFromRoot);

if (!profiles.length) {
  console.error('No Chrome/Edge/Brave profile found. Pass --profile "<path to the Default folder>".');
  process.exit(1);
}

// Editors the clinic form used, plus the usual column names of an import.
const CLINICAL_FIELD = /^(name|fullname|patientname|nameinput|phone|phoneno|phonenumber|phoneinput|mobile|mobilenumber|contact|contactnumber|reg|regno|reginput|registration|registrationnumber|notes|note|notesinput|age|gender|city)$/i;
const PHONE_VALUE = /^[+]?[\d][\d\s-]{8,14}$/;
const REG_VALUE = /\b[A-Z]{2,5}[- ]?\d{2,4}[- ]?\d{3,4}\b/i;

const tmp = join(tmpdir(), 'clinic-trace-scan-' + Date.now());
mkdirSync(tmp, { recursive: true });

function toIso(seconds) {
  const n = Number(seconds);
  if (!n) return '';
  return new Date(n * 1000).toISOString();
}

function scanAutofill(profile) {
  const src = join(profile.dir, 'Web Data');
  if (!existsSync(src)) return { available: false, groups: [] };

  const copy = join(tmp, profile.profile + '-webdata.db');
  try { copyFileSync(src, copy); } catch (e) { return { available: false, error: String(e.message || e) }; }

  let db;
  try { db = new DatabaseSync(copy); } catch (e) { return { available: false, error: String(e.message || e) }; }

  let rows = [];
  try {
    rows = db.prepare('select name, value, date_created, count from autofill').all();
  } catch (e) {
    return { available: true, groups: [], error: String(e.message || e) };
  }

  const buckets = new Map();
  for (const r of rows) {
    const field = String(r.name || '');
    const value = String(r.value || '');
    if (!value) continue;
    const looksClinical = CLINICAL_FIELD.test(field.replace(/[^a-z0-9]/gi, '')) ||
                          PHONE_VALUE.test(value.trim()) || REG_VALUE.test(value);
    if (!looksClinical) continue;

    const key = String(Math.floor(Number(r.date_created) || 0));
    if (!buckets.has(key)) buckets.set(key, { at: toIso(r.date_created), fields: {} });
    const bucket = buckets.get(key);
    const clean = field.replace(/[^a-z0-9]/gi, '').toLowerCase();
    if (!bucket.fields[clean] || value.length > String(bucket.fields[clean]).length) bucket.fields[clean] = value;
  }

  const groups = [...buckets.values()].filter((g) => {
    const keys = Object.keys(g.fields);
    const hasPerson = keys.some((k) => /name/.test(k));
    const hasContact = keys.some((k) => /phone|mobile|contact|reg/.test(k));
    return hasPerson && hasContact;
  }).sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return { available: true, totalAutofillRows: rows.length, groups };
}

function scanSessions(profile) {
  const dir = join(profile.dir, 'Sessions');
  if (!existsSync(dir)) return { files: 0, registrations: [], phones: [] };

  const regs = new Set();
  const phones = new Set();
  let files = 0;

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    try { if (!statSync(path).isFile()) continue; } catch (e) { continue; }
    files++;
    let text = '';
    try { text = readFileSync(path, 'latin1'); } catch (e) { continue; }
    for (const m of text.matchAll(/\b[A-Z]{2,5}-\d{4}-\d{3,5}\b/g)) regs.add(m[0]);
    for (const m of text.matchAll(/\b[6-9]\d{9}\b/g)) phones.add(m[0]);
  }

  return { files, registrations: [...regs], phones: [...phones] };
}

const report = { generatedAt: new Date().toISOString(), profiles: [] };

for (const profile of profiles) {
  const autofill = scanAutofill(profile);
  const sessions = scanSessions(profile);
  report.profiles.push({
    browser: profile.browser,
    profile: profile.profile,
    path: profile.dir,
    autofill,
    sessions
  });
}

// Restore-ready rows: only groups that carry enough to identify a patient.
const rows = [];
for (const p of report.profiles) {
  for (const g of p.autofill.groups || []) {
    const f = g.fields;
    const pick = (re) => {
      const k = Object.keys(f).find((x) => re.test(x));
      return k ? String(f[k]).trim() : '';
    };
    const name = pick(/^name|fullname|patientname|nameinput$/);
    const phone = pick(/phone|mobile|contact/);
    const reg = pick(/reg/);
    const notes = pick(/notes/);
    if (!name || (!phone && !reg)) continue;
    rows.push({ name, phone, reg, meta: { notes, recoveredFrom: 'browser-autofill', at: g.at }, createdAt: g.at, updatedAt: g.at });
  }
}

const restore = {
  app: 'clinic-patient-directory',
  version: 2,
  exportedAt: new Date().toISOString(),
  source: 'browser-traces',
  count: rows.length,
  rows,
  tombstones: {},
  seeded: false
};

writeFileSync(outPath, JSON.stringify({ ...report, restore }, null, 2));
writeFileSync(outPath.replace(/\.json$/i, '') + '-restore.json', JSON.stringify(restore, null, 2));

console.log('Scanned profiles:');
for (const p of report.profiles) {
  console.log(' -', p.browser, p.profile, '| autofill rows:',
    p.autofill.totalAutofillRows ?? 'n/a',
    '| patient-like groups:', (p.autofill.groups || []).length,
    '| session regs:', p.sessions.registrations.length,
    '| session phones:', p.sessions.phones.length);
}
console.log('Restore-ready records rebuilt from autofill:', rows.length);
console.log('Report:', outPath);
console.log('Restore file:', outPath.replace(/\.json$/i, '') + '-restore.json');
console.log('');
console.log('Open the report and check every entry against the clinic register before importing.');
console.log('To load the rebuilt records: open the Patient Directory, press Restore, choose the -restore.json file.');
