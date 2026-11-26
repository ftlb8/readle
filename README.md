# Readler

Live at https://readler.app

A personal read-later app: save links from the phone's share sheet or a desktop
browser, then read them in a clean view, online or offline.

## Layout

- `src/` — the app (React + TypeScript)
  - `store.ts` — keeps the on-device copy and the server in step; queues saves made offline
  - `db.ts` — the on-device copy (IndexedDB)
  - `List.tsx`, `Reader.tsx`, `Login.tsx` — the three screens
- `public/sw.js` — keeps the app itself available offline
- `public/manifest.webmanifest` — makes it installable and adds it to Android's share sheet
- `extension/` — Chrome extension that saves the current tab, including pages behind a login
- `curation/` — the weekly suggestions: `collect.mjs` reads the sources' feeds daily and records
  candidate articles; `judge.mjs` scores them each Saturday and stores the picks
  (`sources.json` is the list of sources and their filters)
- `supabase/migrations/` — database tables and security rules
- `supabase/functions/save/` — fetches a saved link and extracts the readable article
  (or the embed details for a video)

Backend: Supabase project `readle` (ref `kgnpncskdmzwqmjrrupx`).

## Commands

- `npm run dev` — run locally at http://localhost:3000 (no offline support in this mode)
- `npm run build` — check types and build into `dist/`
- `npm run preview` — serve the built version, including offline support

## Chrome extension

1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose the `extension` folder.
3. Click the Readler button in the toolbar and sign in with your Readler email and password.

After that, clicking the button (or pressing Alt+Shift+S) saves the current tab.
Right-clicking a link offers **Save link to Readler**.

## Adding a person

Sign-ups are closed. To invite someone, create their account in the Supabase
dashboard (Authentication → Users → Add user → Create new user, with
"Auto Confirm User" ticked) and give them the temporary password. They change
it in the app under Account → Set password.

Each person can keep up to 1000 items. To change that for one person, run in
the SQL editor:

    insert into public.user_limits (user_id, max_items)
    select id, 3000 from auth.users where email = 'person@example.com'
    on conflict (user_id) do update set max_items = excluded.max_items;
