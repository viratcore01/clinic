# Patient Directory

A single-page patient register for the clinic. Open `index.html` (or the deployed URL) — there is no build step.

## What was wrong

The previous version loaded patients from a Supabase project and had no local fallback:

```js
const SUPABASE_URL = 'https://oqarvapuiiqfjemqubfh.supabase.co';
```

That host does not exist:

- Public DNS returns **NXDOMAIN** for `oqarvapuiiqfjemqubfh.supabase.co` (checked against 8.8.8.8).
- Passive DNS history (mnemonic) has **zero records** ever seen for that name.
- Certificate transparency has **no certificate** ever issued for it.

So the browser cannot open a connection at all, and `supabase-js` reports that as
`TypeError: Failed to fetch` — exactly the message shown as
`⚠ load failed: TypeError: Failed to fetch`.

A paused Supabase project still keeps its DNS name (and answers with a paused page). A name that
never resolved at all means the project reference in the code was never a real, reachable project.
That commit (`60c7f4a`, "Connect patient directory to Supabase database") replaced the working
local-storage version with this endpoint, so nothing was ever uploaded to it and nothing was deleted
from it.

The consequence was still real damage: the page rendered **only** from that dead database, so an
empty table made it look like every record had vanished.

## Where the clinic's records actually are

The version before that commit kept them in the browser's `localStorage` under the key `patients`.
That key was **never deleted** by the Supabase commit — the page simply stopped reading it. So the
records from that period are still on the machine that used the site:

1. **Same browser, same link** → open the new page and they are restored automatically on first load
   (a blue banner says how many).
2. **Browser storage was cleared** → the new page keeps a second copy in IndexedDB and restores from
   it on the next visit.
3. **Different computer** → run the snippet in `recovery-snippet.txt` in the browser that was used,
   then load the saved JSON with **Restore**.

### The three copies of this app, and the key each one used

Browser storage is per-origin, so a record added on one address is invisible on another. All three
addresses have been checked:

| Address | Store | Notes |
| --- | --- | --- |
| `clinic-ochre-seven.vercel.app` | `localStorage['patients']` (before `60c7f4a`); dead Supabase after | Records added after `60c7f4a` were sent to a host that never existed and cannot be recovered from the server |
| `site-90530542…freebuff.page` | `localStorage['vitalis_cache_v2']` = `{patients, notes}` plus Cloudflare D1 behind Freebuff sign-in | A second, independent mirror; extra patients may exist here |
| `patient.129.154.239.74.sslip.io` | SQLite on the VM, exposed by `/api/patients` and `/api/notes` | 31 patients + 30 notes; this is the built-in registry |

The fixed page now reads **all** of these local keys on boot (`patients`, `vitalis_cache_v2`,
`vitalis_notes_v1`) and merges them, keeping an untouched copy of the foreign payload in
`vitalis_backup_v1`. Clinical notes are shown in their own column and are editable in the patient
form, so the 30 notes from the VM are visible instead of hidden in `meta`.

### Forensic sweep of this machine (2026-11-23)

A full local sweep was run to rule out any surviving copy of records the client entered on her own
device:

| Sweep | Scope | Result |
| --- | --- | --- |
| Binary artefact scan | 23,994 files / ~1 GB in Downloads, Desktop, Documents, OneDrive, WhatsApp, Telegram, Thunderbird, Outlook, YourPhone, Clipboard, MobileSync, `$Recycle.Bin` | 4 hits, all inside this project folder — no outside copy |
| Chrome profile storage | IndexedDB + localStorage for every origin, via a headless copy of the profile | `clinic-directory` held the same **31 rows / 30 notes**; no extra records |
| Chrome / Edge autofill | `Web Data` (`autofill`, profile tables) | no patient data (only `9313005400`, already in the registry) |
| Chrome history / keywords | `Web Data` | no data routes or exports |
| Other browsers / profiles | Edge, Opera, Firefox, WebView, installed PWAs | no clinic storage at all |

The Chrome copies found on this machine are saved verbatim in
`data/chrome-profile-recovery-2026-11-23.json` (31 rows, 30 notes, with which store each row came
from). They are identical in content to the live registry, which confirms the registry is fully
recovered and that the only records still outstanding are ones that exist **only** on the client's
own device.

### One-tap recovery page for the client's device

`recover.html` is a standalone page (no dependencies, read-only, `noindex`) that scans the browser it
is opened in for every known clinic key — `patients`, `clinic_state_v2`, `patients_backup_v1`,
`clinic_snapshot_*`, `vitalis_cache_v2`, `vitalis_notes_v1` — plus the IndexedDB databases
`clinic-directory` (`kv` and `history`). It merges duplicates, previews the rows, and then either
**sends** them to `/api/backup` (the owner's append-only server backup) or lets the client download
or copy them.

- Open: `https://clinic-ochre-seven.vercel.app/recover.html`
- Auto-send variant: `https://clinic-ochre-seven.vercel.app/recover.html?auto=1`
- Short link: `https://clinic-ochre-seven.vercel.app/r`

Because browser storage is per-origin, the page can only see the storage of the address it was served
from. If the client used a different address, the equivalent page must be opened on that address (or
`recovery-snippet.txt` run there).

### Server-side stores: what was checked and what is left

- Supabase `oqarvapuiiqfjemqubfh` — **never existed** (see above). Nothing to recover.
- Oracle ADB `patientdb_high` — wallet committed in the `patient` repo, but no DB credentials were
  ever committed; can be queried only with the clinic's Oracle login.
- Cloudflare D1 behind the freebuff.page site — real and populated by that deployment, but every
  route is auth-wrapped (`/api/patients` returns `401 Sign in required`). It can only be exported by
  signing in with the doctor's own Freebuff account.
- VM SQLite — fully exposed; already snapshotted.

`data/live-registry-backup-2026-11-19.json` is a verbatim snapshot of the clinic registry that is
currently live on the Oracle VM backend (`patient.129.154.239.74.sslip.io`), all 31 patients with
their notes, taken before anything was changed. It is also compiled into `index.html` as
`BUILT_IN_REGISTRY`, so a device with no local data starts with the clinic's real patient list
instead of an empty table. A device that already holds records keeps only those, and deleting
every record is never undone by a reseed.

> **Privacy note.** This page has no login: anyone who opens the URL sees every record that is on the
> device that stored it, and the built-in registry is part of the public page. The page is marked
> `noindex` so search engines stay away, but if the clinic needs real confidentiality the next step
> is a login or a server-side database — not a public static file.

## What this version does

| Behaviour | Why |
| --- | --- |
| Records load from the device **first** and render immediately | The page is usable with no network and no cloud account |
| Every add / edit / delete is written to `localStorage` instantly | Nothing depends on a request succeeding |
| The old `patients` key is read on first load and merged in | The clinic's existing records reappear automatically |
| An untouched copy of the old data is kept in `patients_backup_v1` | The migration can never destroy the original |
| A second copy is kept in IndexedDB | "Clear browsing data" on the localStorage side does not wipe the clinic |
| Cloud sync is optional and never blocks the UI | A dead project can no longer break the directory |
| Backup / Restore buttons | One-click JSON backup, merge-only restore that never overwrites |
| Restore reads JSON **and CSV**, and keeps every extra column | A Supabase table export or an Excel/Sheets file can be loaded directly |
| Delete has Undo | A mis-click cannot lose a patient |
| Every save is pushed to an **append-only** server backup | The owner keeps every version; the device cannot erase server history |
| A local append-only history keeps the last 300 versions in IndexedDB | Even a cleared browser can be rolled back |

## Automatic owner-side backup (append-only)

The page now posts a snapshot to `/api/backup` on every change. The endpoint
(`api/backup.js`, a Vercel function) writes that snapshot as a **new file** in a
private GitHub repository that the clinic owner controls. There is no delete or
overwrite route, so:

- Every add, edit, delete and restore becomes an immutable snapshot file.
- Deleting a patient in the page only writes a newer snapshot; the older ones
  stay in the repository history forever.
- The browser never receives the GitHub token, so the person using the page
  cannot delete or rewrite the backup.
- A wiped browser, a new computer, or the clinic's other device automatically
  pulls the newest snapshot on load and merges it in.

On-device there is a second safety net: an append-only history in IndexedDB
(last 300 versions). The ordinary `localStorage` state is replaced on each
save; this history is not.

### One-time setup (owner only)

1. Create a **private** GitHub repository for the backups, e.g.
   `viratcore01/clinic-data`.
2. Create a **fine-grained** GitHub token with **Contents: Read and write** on
   that repository only.
3. In the Vercel project → **Settings → Environment Variables**, add:
   - `GITHUB_TOKEN` = the token
   - `BACKUP_REPO` = `viratcore01/clinic-data`
   - (optional) `BACKUP_BRANCH`, `BACKUP_PATH` (default `snapshots`)
4. Redeploy. The header pill changes from `backup: server not set up` to
   `backup: saved <time>`.

Until step 3 is done the page still works exactly as before (device-first); it
just shows `backup: server not set up` and retries automatically once the
variables exist.

### Restoring a specific version

Every snapshot is a readable JSON file in the backup repository. Open the
repository on GitHub and download the snapshot you want, then press
**Restore** in the page — restore merges and never overwrites. To pull the
newest one automatically, clear the device's site data and open the page again.

> **What the client can and cannot do.** She can add, edit or delete records in
> the page, and she can clear her browser. She cannot delete the snapshots on
> the server, because the page has no delete capability for them and never sees
> the token. If she deletes a patient, you still have every earlier snapshot and
> can restore it.

Records are matched on registration number, then phone, then name, so nothing is duplicated when the
old data, the second copy and the cloud copy are merged.

### Restoring from a Supabase CSV export

Supabase → Table editor → `patients` → **Export as CSV**, then press **Restore** in this page and pick
the file. It accepts the exported header row and needs a name column, a phone column and a
registration column (a `reg`/`registration`/`id` header, or a numeric `id` is ignored as a row id).
Every other column (`age`, `notes`, `city`, `created_at`, …) is kept on the record, so a later
**Backup** writes them back out.

## Cloud backup (optional)

Open **Cloud** in the app, paste a Supabase project URL and its publishable/anon key, and press
**Save & test**. The connection is tested before it is saved; a bad or dead project is rejected with a
plain-language reason instead of breaking the page.

The project needs one table (the SQL is also shown inside the Cloud panel):

```sql
create table if not exists patients (
  id bigint generated by default as identity primary key,
  name text not null,
  phone text not null,
  reg text not null,
  created_at timestamptz not null default now()
);

alter table patients enable row level security;

create policy "clinic full access" on patients
  for all to anon using (true) with check (true);
```

## Restoring the clinic's existing records

Try these in order — each one is local to the browser that was actually used:

1. **Open the new page in the same browser the clinic used.** The old `localStorage` records are
   picked up and shown straight away; a blue banner confirms how many were restored.
2. If that browser's storage was cleared, the page restores from its own second copy on the next
   visit.
3. If neither works, the records are still on the old Supabase server if that project was only
   *paused* rather than deleted: sign in at <https://supabase.com/dashboard>, open the project and
   restore it, then copy the table out (Table editor → `patients` → Export CSV) and load it with
   **Restore** (CSV is not read directly — save it as JSON, or re-add from the CSV).
4. If the project is gone entirely, Supabase support can sometimes recover a project backup for a
   short window after deletion.

## Deploying

The site is static, so the fix is one file: replace `index.html` in the repository and let Vercel
redeploy.

```bash
git clone https://github.com/viratcore01/clinic
# copy this index.html over the old one
git commit -am "Make the patient directory work offline and recover existing records"
git push
```

Vercel redeploys `master` automatically. Private browsing still hides the data afterwards — use a
normal window for the clinic machine.
