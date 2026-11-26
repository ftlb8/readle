# Readle

A personal read-later app: save links from the phone's share sheet or a desktop
browser, then read them in a clean view, online or offline.

## Layout

- `src/` — the app (React + TypeScript)
  - `store.ts` — keeps the on-device copy and the server in step; queues saves made offline
  - `db.ts` — the on-device copy (IndexedDB)
  - `List.tsx`, `Reader.tsx`, `Login.tsx` — the three screens
- `public/sw.js` — keeps the app itself available offline
- `public/manifest.webmanifest` — makes it installable and adds it to Android's share sheet
- `supabase/migrations/` — database tables and security rules
- `supabase/functions/save/` — fetches a saved link and extracts the readable article
  (or the embed details for a video)

Backend: Supabase project `readle` (ref `kgnpncskdmzwqmjrrupx`).

## Commands

- `npm run dev` — run locally at http://localhost:3000 (no offline support in this mode)
- `npm run build` — check types and build into `dist/`
- `npm run preview` — serve the built version, including offline support
