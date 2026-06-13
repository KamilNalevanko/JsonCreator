README - CAP Leaflet Editor (prebuilt local release)

Goal
- End user starts app locally without npm install and without npm run build.

How developer creates release ZIP
1) In project root run:

   npm run release:zip

2) Send produced file:

   dist\\CAP-Leaflet-Editor-win-x64.zip

What this ZIP contains
- Prebuilt Next standalone server
- Runtime node_modules needed by app
- .next/static and public assets
- RUN_APP.cmd and STOP_APP.cmd
- .env.example and README_INSTALL.txt

Requirements on customer PC
- Windows x64
- Node.js LTS installed

How customer starts app
1) Unzip package.
2) Create .env.local from .env.example (fill real keys).
3) Double-click RUN_APP.cmd.
4) Open http://localhost:3000

How customer stops app
- Close terminal opened by RUN_APP.cmd, or run STOP_APP.cmd.

Important
- Customer does not run npm install.
- Customer does not run npm run build.
- Never distribute .env.local with real secrets.
