# Privacy — Basanite Capital LinkedIn → Airtable

- **What it reads:** LinkedIn data visible to your signed-in account — connections, profiles, search results, company employees and pages, mutual connections, and your conversation list for *when* you last talked with someone and who wrote last. Message text is never used or stored, and neither your notifications feed nor individual message threads are read.
- **Where it goes:** only to the Airtable base you configure, using your own personal access token. Photos and logos are checked on LinkedIn's image CDN (no cookies sent) and handed to Airtable as links, which Airtable copies. There is no Basanite or third-party server in between, and no analytics.
- **What's stored locally** (in `chrome.storage.local`, on this browser only):
  - your Airtable token, base/table setup and column mapping;
  - for each table, a map of LinkedIn URL → Airtable record id with fingerprints of the cells last written (and the LinkedIn member id, so a changed profile URL still finds its row);
  - a cache of company pages (name, About, website, industry, logo link) so each company is looked up once;
  - sync checkpoints and progress, and a paused bulk enrich's list of profile URLs until it finishes or is stopped (after that, only its counts are kept).
  Captured people's profiles are not kept locally; they go to Airtable only.
- **When it runs:** when you press a capture button, and on the soft-sync schedule you control in the panel (only after your first full sync).
- **Removing it:** Settings → Disconnect Airtable removes the token, the setup, and every local index, cache and checkpoint made for the base. Uninstalling the extension removes everything.
