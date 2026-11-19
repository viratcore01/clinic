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
Those records are still on the machine that used the site:

1. **Same browser, same link** → open the new page and they are restored automatically on first load
   (a blue banner says how many).
2. **Browser storage was cleared** → the new page keeps a second copy in IndexedDB and restores from
   it on the next visit.
3. **Different computer** → run the snippet in `recovery-snippet.txt` in the browser that was used,
   then load the saved JSON with **Restore**.
4. **Records only existed in a real cloud project** → that project can be restored from the Supabase
   dashboard if it is paused, or from a Supabase backup if it was deleted.

A machine-level search of this computer (Chrome, Brave, Edge: localStorage, IndexedDB, session data)
found **no** patient records for the old site, which confirms the data lives with the clinic's own
browser rather than with this development machine.

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
