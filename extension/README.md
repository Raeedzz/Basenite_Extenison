# Basanite Capital — LinkedIn → Airtable

Chrome MV3 extension. Captures LinkedIn people straight into an Airtable table and keeps them fresh. No backend: the extension talks to LinkedIn (your browser session) and Airtable (your token) directly.

## Install (unpacked)

1. `chrome://extensions` → Developer mode → **Load unpacked** → this `extension/` folder.
2. Click the toolbar icon to open the side panel. It opens on setup.
3. Paste a personal access token from <https://airtable.com/create/tokens> with scopes
   `data.records:read`, `data.records:write`, `schema.bases:read`
   (+ `schema.bases:write` if you want the extension to create columns — you also need creator access —
   and `user.email:read` so Settings can show which account Known by uses), and grant it your base.
4. Pick base and table. Columns are pre-mapped by name (e.g. "Work Experience" → Experience, "Education History" → Education, "Past Companies" → Past companies); fix anything, or **Create missing**. A **LinkedIn URL** column is required — it's the match key.

   Capture controls only appear once all three steps are done. Everything happens in the side panel; the gear icon reopens setup.

5. Stay signed in to linkedin.com in the same Chrome profile.

Network: **Network** is *In network* for your 1st-degree connections and *Outside network* for everyone else (2nd, 3rd, beyond), from the degree LinkedIn reports. A single select, a text column, or a checkbox (checked = in network).

Images: People **Photo**, Companies **Logo**, and Schools **Logo** (attachment columns) get LinkedIn's largest image, named `<slug>.jpg`. Filled only while blank — a photo or logo already there (including one you uploaded) is never replaced, appended to, or cleared. LinkedIn's placeholder avatar and expired links are never sent, and each image is checked before the write; one that won't download is skipped for that record and the rest still lands. The same photo isn't re-sent just because LinkedIn re-signed its URL. Company logos are cached with the company details and looked up again only when a Logo is still blank and the cached link has expired.

Work history: **Current title/company**, **Previous title/company** (latest role they've left), **Past companies** (every company they've left), **Experience** (every role, one line each, no dates) and **Experience timeframes** (the same roles' dates, line for line — "—" where a role has none). **Additional info** is optional (write it only by mapping it): each role's location, company LinkedIn page and description, plus certifications and volunteering. Education: **Education** (every school with degree and field, no dates), **Education timeframes** (the same schools' dates, line for line), **All schools**, **Latest school**.

## Linked tables (optional, setup step 4)

Pick a **Companies**, **Work history**, and **Schools** table, plus the People link columns that point at them. Auto-match only offers link columns that point at the right table, and never auto-picks columns named *DELETE ME*, *sample*, or *example*. Each full profile then:

1. finds or creates each company: by LinkedIn page, then by name (only rows with no LinkedIn page). On a row that already exists, only blank cells are filled. About, website, and sector come from LinkedIn, once per company, cached.
2. finds or creates each school: by LinkedIn page, then by name. Only blanks are filled.
3. writes the person: Name/Location/etc. only fill blanks (or replace what the extension itself wrote); Headline is always kept current. *Worked at* and *Education* links only ever gain links. *Current company* links the company of the current role (the same role Title reads); it fills a blank cell or replaces what the extension set, never a company set by hand, and is never cleared.
4. writes one Work history row per job (person + company + title + start month), kept current.

Nothing is ever deleted. A job that disappears from LinkedIn keeps its row.

**Sync as often as you like — no duplicates.** Every row is found before anything is created: people by LinkedIn URL (and by LinkedIn member id if their URL changed), companies and schools by LinkedIn page then name, jobs by person + company + title + start month (an edited title updates the same job). A create whose outcome is unknown (timeout, 5xx) is never blindly re-sent, and a write cut off by a crash or reload makes the next write re-read every table first. On a shared base, people about to be created are first looked up in Airtable itself, so someone a teammate (or their extension) added since the last read is updated — Known by gains you — rather than added twice; Companies and Education are re-read when older than 10 minutes.

People extras:
- **New-row marker** (e.g. *Enrichment review* = "Added By Branch"): set only on rows the extension creates, sent with `typecast:false`; never touched on existing people.
- **Referred by**: written only when a referrer is known and the cell is blank.
- **Source** is never auto-mapped; pick it by hand if you want it.

## What it captures

| Panel action | Writes |
|---|---|
| Sync LinkedIn network | every 1st-degree connection + full profile, message metadata |
| Quick refresh / automatic soft sync | re-walks connections; only people not yet in the table get the profile pass |
| This profile → Add to Airtable | the LinkedIn profile open in the active tab |
| This profile → Log interaction | one **Interactions** row (types, when, person) and, if a note was typed, one **Notes** row it links; adds the person to People first if they aren't there |
| Enrich a table | every LinkedIn URL in a column of any table in the base (e.g. *Dex Contacts* → *LinkedIn*), full profile into People like a sync; up to 10,000, deduped, resumable, Source = `Table: <name>` on new rows |
| Enrich LinkedIn URLs | pasted profile URLs (up to 2,000), same as above |
| People at a company | current employees (optionally by role keywords), enriched |
| Search LinkedIn → Add selected | picked search results, enriched |
| Find mutuals | mutual-connection count + names onto each target's row |

Log interaction needs the base's **Interactions** and **Notes** tables (Basanite OS layout) linked to the People table; the button only shows when they're there. Tables added later are picked up on the next soft sync (or **Reload columns**). It is create-only: it never edits or deletes an interaction or note. Types must already be options on the Types column. If the interaction fails after its note was saved, **Retry** links that same note instead of writing another; a write that timed out is looked up before it is sent again.

## How writes work

- Rows are matched on LinkedIn URL (`/in/<slug>`, format-insensitive). Existing rows are filled in, never duplicated.
- Only cells whose captured value changed are sent; an unchanged network costs zero Airtable requests. A cell you edit by hand stays until LinkedIn's value changes.
- Empty captured values never blank a cell. `Source` is set on create only.
- Rows deleted in Airtable are recreated on the next full sync.
- Requests are paced under Airtable's 5 req/s limit; 429/5xx/network drops are retried.
- Soft sync defaults to hourly (24×/day) and only starts after your first manual full sync. Change it on the Capture tab. Runs only while Chrome is open; after a restart the schedule picks up from your last sync, and an overdue one runs about 10 minutes after Chrome opens. Every soft sync (scheduled or Quick refresh) re-reads the base's tables and columns first.

## Layout

- `background/linkedin-capture.js`, `background/linkedin-graph.js` — LinkedIn engines (from EarthOS, unchanged logic)
- `lib/api-client.js` — the engines' import API, fulfilled locally against Airtable
- `lib/airtable-sink.js` — config, row index, change detection, write queue
- `lib/airtable-fields.js` — capture fields, auto-mapping, type coercion (pure)
- `lib/airtable-client.js` — Airtable REST + rate limiting/retries
- `popup/` — side panel

## Tests

```bash
node --test tests/*.test.mjs
```

Rebuild the Rust/Wasm connection parser with `capture-worker-rs/build.sh`.
