README — CAP Leaflet Editor (minimal ZIP, no `.next` or `node_modules`)

This package is prepared as a minimal ZIP: it does NOT contain `node_modules` or the Next.js build output (`.next`).
Recipient must have Node.js and internet access to install production dependencies and build the app.

Before creating the ZIP (on your machine):
- Remove any local build/output and sensitive files to avoid shipping stale binaries or secrets.

Run these commands in the project root before zipping:

    rmdir /s /q .next
    rmdir /s /q node_modules
    del /q .env.local
    REM (Optionally) remove .git if you pack only source files

This ensures the recipient always does a fresh `npm ci` and `npm run build`.

Prerequisites (on recipient machine):
- Node.js LTS installed (https://nodejs.org/) — verify with `node -v` and `npm -v`
- Internet access (for `npm ci`)

Files included in this ZIP (important):
- `package.json` and `package-lock.json`
- `CAP-Json-creator.cmd` and `CAP-Json-creator.vbs` (launchers)
- `app/`, `public/`, `assets/`, `scripts/` (source files)
- `.env.example` (example env vars) — create `.env.local` from this
- `README_INSTALL.txt` (this file)

How to run (one command launcher):
1. Unzip to a folder, e.g. `C:\cap-leaflet-editor`.
2. Open Command Prompt and run:

    cd "C:\cap-leaflet-editor"
    CAP-Json-creator.cmd

The launcher will:
- stop any running Node processes
- run `npm run build` if the `.next` build is missing
- ensure production deps (will run `npm ci --omit=dev` if needed)
- start the production server and open http://localhost:3000

Manual alternative (if launcher fails):
1. Open Command Prompt and run:

    cd "C:\cap-leaflet-editor"
    npm ci --omit=dev
    npm run build
    npm start

Environment variables:
- Create `.env.local` in the project root (do NOT commit or share it). Use `.env.example` as template.
- Important keys: `OPENAI_API_KEY`, `SUPABASE_URL`, `SUPABASE_ANON_KEY` (if used).

Secrets management options:
- Keep `.env.local` locally on your machine and DO NOT include it in the ZIP you send to customers.
- If you want centralized secrets for deployed servers, use Supabase project settings / environment variables (set via Supabase dashboard) or your hosting provider's secret manager — these are safe for server deployments.
- Do NOT store raw API keys in a public Supabase table accessible from the browser. If you store secrets in your database, encrypt them and ensure only server-side code (with a service role key) can read them.
- For local customer installs, the simplest secure approach is to provide an `.env.example` and ask the customer to create `.env.local` with their own keys.

Troubleshooting:
- If `npm ci` fails, ensure internet and enough disk space; copy exact error and send for help.
- If browser doesn't open, point to http://localhost:3000 manually.
- Windows might block Node as a firewall prompt — allow it.

If you prefer zero-install (no Node on client), create a one-click ZIP that includes `node_modules` and `.next` (will be much larger). Contact me and I can prepare that.

Security note:
- Never include `.env.local` with real API keys in distributed ZIPs. Provide an `.env.example` and instructions to fill it.

-- End of README
