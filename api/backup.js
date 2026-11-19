/**
 * Append-only backup endpoint for the Patient Directory.
 *
 * Every save from the page becomes a NEW immutable snapshot file in a
 * private GitHub repository that the clinic owner controls. There is no
 * delete or overwrite route: once a snapshot is written it stays in the
 * repository history, even if the page (or the person using it) deletes
 * every patient locally.
 *
 * Required environment variables (set in Vercel → Settings → Environment
 * Variables, then redeploy):
 *
 *   GITHUB_TOKEN   fine-grained token with "Contents: Read and write"
 *                  on the backup repository only
 *   BACKUP_REPO    owner/repo, e.g. "viratcore01/clinic-data"
 *
 * Optional:
 *   BACKUP_BRANCH  branch to write to (default: the repo's default branch)
 *   BACKUP_PATH    folder for snapshots (default: "snapshots")
 *
 * GET  /api/backup   → newest snapshot (used to restore a wiped device)
 * POST /api/backup   → { snapshot } appended as a new snapshot file
 *
 * No token or repository name is ever sent to the browser.
 */

const API = 'https://api.github.com';

function cfg() {
  const repo = (process.env.BACKUP_REPO || '').trim();
  const token = (process.env.GITHUB_TOKEN || '').trim();
  const branch = (process.env.BACKUP_BRANCH || '').trim();
  const dir = (process.env.BACKUP_PATH || 'snapshots').trim().replace(/^\/+|\/+$/g, '');
  return { repo, token, branch, dir };
}

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'clinic-patient-directory'
  };
}

function json(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body && typeof req.body === 'object') return resolve(req.body);
    if (typeof req.body === 'string') {
      try { return resolve(JSON.parse(req.body)); } catch (e) { return reject(e); }
    }
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) {
        reject(new Error('Snapshot too large'));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function validateSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') throw new Error('Missing snapshot');
  const rows = snapshot.rows;
  if (!Array.isArray(rows)) throw new Error('Snapshot has no rows array');
  if (rows.length > 20000) throw new Error('Snapshot has too many rows');
  for (const row of rows) {
    if (!row || typeof row !== 'object') throw new Error('Snapshot contains an invalid row');
    if (typeof row.name !== 'string' || typeof row.phone !== 'string' || typeof row.reg !== 'string') {
      throw new Error('Snapshot row is missing name/phone/reg');
    }
  }
  return snapshot;
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function ghGet(repo, path, token, branch) {
  const url = `${API}/repos/${repo}/contents/${encodeURI(path)}${branch ? `?ref=${encodeURIComponent(branch)}` : ''}`;
  const r = await fetch(url, { headers: ghHeaders(token) });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub read failed (${r.status})`);
  return r.json();
}

async function ghPut(repo, path, token, branch, body, options) {
  const overwrite = !!(options && options.overwrite);
  let sha = null;

  const existing = await ghGet(repo, path, token, branch);
  if (existing && existing.sha) {
    if (!overwrite) return { duplicate: true };
    sha = existing.sha;
  }

  const url = `${API}/repos/${repo}/contents/${encodeURI(path)}`;
  const payload = {
    message: body.message,
    content: Buffer.from(body.content, 'utf8').toString('base64')
  };
  if (branch) payload.branch = branch;
  if (sha) payload.sha = sha;

  const r = await fetch(url, {
    method: 'PUT',
    headers: { ...ghHeaders(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await r.json().catch(() => ({}));
  if (r.status === 422 && data && /already exists/i.test(String(data.message || ''))) {
    return { duplicate: true };
  }
  if (!r.ok) {
    throw new Error(`GitHub write failed (${r.status}): ${data.message || 'unknown error'}`);
  }
  return { duplicate: false, commit: data.commit && data.commit.sha };
}

async function newestSnapshot(c, dir) {
  // Try the pointer first; it is one small read.
  const pointer = await ghGet(c.repo, 'latest.json', c.token, c.branch);
  if (pointer && pointer.content) {
    try {
      const snap = JSON.parse(Buffer.from(pointer.content, 'base64').toString('utf8'));
      if (snap && Array.isArray(snap.rows)) return { path: 'latest.json', snapshot: snap };
    } catch (e) { /* fall through to the listing */ }
  }

  const listing = await ghGet(c.repo, dir, c.token, c.branch);
  if (!Array.isArray(listing)) return null;
  const files = listing
    .filter((f) => f.type === 'file' && /\.json$/i.test(f.name))
    .sort((a, b) => (a.name < b.name ? 1 : -1));
  if (!files.length) return null;

  const latest = files[0];
  const file = await ghGet(c.repo, latest.path, c.token, c.branch);
  if (!file || !file.content) return null;
  const snap = JSON.parse(Buffer.from(file.content, 'base64').toString('utf8'));
  return { path: latest.path, snapshot: snap };
}

module.exports = async function handler(req, res) {
  const c = cfg();
  if (!c.repo || !c.token) {
    return json(res, 503, {
      ok: false,
      error: 'Backup is not configured on the server. Set GITHUB_TOKEN and BACKUP_REPO in Vercel, then redeploy.'
    });
  }

  try {
    if (req.method === 'GET') {
      const latest = await newestSnapshot(c, c.dir);
      if (!latest) return json(res, 200, { ok: true, path: null, snapshot: null });
      return json(res, 200, { ok: true, path: latest.path, snapshot: latest.snapshot });
    }

    if (req.method === 'POST') {
      const body = await readBody(req);
      const snapshot = validateSnapshot(body.snapshot || body);
      snapshot.takenAt = snapshot.takenAt || new Date().toISOString();

      // Serialize deterministically enough that an identical save is idempotent.
      const text = JSON.stringify(snapshot, null, 2);
      const digest = require('crypto').createHash('sha256').update(text).digest('hex').slice(0, 16);
      const name = `${stamp()}-${digest}.json`;
      const path = `${c.dir}/${name}`;

      await ghPut(c.repo, path, c.token, c.branch, {
        message: `backup: ${snapshot.rows.length} patients (${snapshot.takenAt})`,
        content: text
      });

      // Best-effort pointer for fast restores; history remains in `dir`.
      await ghPut(c.repo, 'latest.json', c.token, c.branch, {
        message: 'backup: update latest pointer',
        content: text
      }, { overwrite: true }).catch(() => {});

      return json(res, 200, { ok: true, path, count: snapshot.rows.length });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'Method not allowed' });
  } catch (err) {
    console.error('[backup]', err);
    return json(res, 500, { ok: false, error: String(err && err.message || err) });
  }
};
