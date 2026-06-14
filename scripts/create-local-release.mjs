import { cp, mkdir, rm, writeFile, access, readFile, stat } from "node:fs/promises";
import { brotliDecompressSync } from "node:zlib";
import path from "node:path";

const root = process.cwd();
const standaloneSrc = path.join(root, ".next", "standalone");
const staticSrc = path.join(root, ".next", "static");
const publicSrc = path.join(root, "public");
const assetsSrc = path.join(root, "assets");
const envLocalSrc = path.join(root, ".env.local");
const envExampleSrc = path.join(root, ".env.example");

const outBase = path.join(root, "dist", "local-release");
const outDir = path.join(outBase, "CAP-Leaflet-Editor");
const launcherName = "Spustiť Editor Letákov.cmd";
const launcherShortcutName = "Spustiť Editor Letákov.lnk";

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function copyIfExists(src, dest) {
  if (await exists(src)) {
    await cp(src, dest, { recursive: true });
  }
}

async function ensureMupdfRuntime() {
  // Nepoužívame require.resolve("mupdf/package.json"), lebo mupdf v nových verziách
  // nemusí exportovať package.json a potom release script falošne hlási, že balík chýba.
  const candidates = [
    path.join(root, "node_modules", "mupdf"),
    path.join(root, "node_modules", "@mupdf", "mupdf"),
  ];

  let mupdfRoot = "";
  for (const candidate of candidates) {
    if (await exists(path.join(candidate, "package.json"))) {
      mupdfRoot = candidate;
      break;
    }
  }

  if (!mupdfRoot) {
    throw new Error(
      "Balík mupdf nie je v node_modules. Spusti npm install mupdf alebo npm ci a potom npm run release:zip."
    );
  }

  const destRoot = path.join(outDir, "node_modules", "mupdf");

  // Next standalone tracing pri WASM balíkoch občas skopíruje neúplný/rozbitý mupdf.
  // Preto ho vo finálnom release vždy prepíšeme čistou kópiou z root node_modules.
  await rm(destRoot, { recursive: true, force: true });
  await mkdir(path.dirname(destRoot), { recursive: true });
  await cp(mupdfRoot, destRoot, { recursive: true });

  const wasmPath = path.join(destRoot, "dist", "mupdf-wasm.wasm");
  const wasmBrPath = path.join(destRoot, "dist", "mupdf-wasm.wasm.br");

  // Ak existuje .wasm.br, vždy z neho vygenerujeme čistý .wasm.
  // Tým sa vyhneme chybe WebAssembly.instantiate(): section extends past end of module.
  if (await exists(wasmBrPath)) {
    const compressed = await readFile(wasmBrPath);
    const decompressed = brotliDecompressSync(compressed);
    await writeFile(wasmPath, decompressed);
  }

  if (!(await exists(wasmPath))) {
    throw new Error("Vo finálnom release chýba node_modules/mupdf/dist/mupdf-wasm.wasm");
  }

  const s = await stat(wasmPath);
  if (s.size < 1_000_000) {
    throw new Error(`mupdf-wasm.wasm vyzerá poškodený, veľkosť je iba ${s.size} bajtov.`);
  }

  console.log(`MuPDF runtime OK: ${path.relative(root, wasmPath)} (${Math.round(s.size / 1024)} KB)`);
}

const runCmd = `@echo off
setlocal
cd /d "%~dp0"

set "SHORTCUT_PATH=%~dp0${launcherShortcutName}"
if not exist "%SHORTCUT_PATH%" (
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$p='${launcherShortcutName}'; $target='${launcherName}'; $base=[System.IO.Path]::GetFullPath('.'); $shortcutPath=Join-Path $base $p; $targetPath=Join-Path $base $target; $w=New-Object -ComObject WScript.Shell; $s=$w.CreateShortcut($shortcutPath); $s.TargetPath=$targetPath; $s.WorkingDirectory=$base; $s.IconLocation='$env:SystemRoot\\System32\\shell32.dll,220'; $s.Description='Spustiť Editor Letákov'; $s.Save()" >nul 2>nul
)

where node >nul 2>nul
if errorlevel 1 (
  echo ERROR: Node.js is not installed or not in PATH.
  echo Install Node.js LTS from https://nodejs.org/
  pause
  exit /b 1
)

echo Starting CAP Leaflet Editor...
echo.
echo Open this URL if browser does not open automatically:
echo http://localhost:3000
echo.
start "" "http://localhost:3000"
node .\\server.js
pause
`;

const stopCmd = `@echo off
setlocal
powershell -NoProfile -Command "Get-Process -Name node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue"
echo Node processes stopped.
pause
`;

const readme = `CAP Leaflet Editor - Local Release

Requirements on customer PC:
- Windows x64
- Node.js LTS installed

How to start:
1) Extract ZIP.
2) Double-click Spustiť Editor Letákov.cmd.
3) App opens at http://localhost:3000.

Do NOT run npm install on customer PC.
Do NOT run npm run build on customer PC.

If port 3000 is busy:
- close other Node apps, or run STOP_APP.cmd.
`;

async function main() {
  if (!(await exists(standaloneSrc))) {
    throw new Error("Missing .next/standalone. Run npm run build first.");
  }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  await cp(standaloneSrc, outDir, { recursive: true });
  await copyIfExists(staticSrc, path.join(outDir, ".next", "static"));
  await copyIfExists(publicSrc, path.join(outDir, "public"));
  await copyIfExists(assetsSrc, path.join(outDir, "assets"));

  await ensureMupdfRuntime();

  // Release appka potrebuje runtime env hodnoty. Ak nechceš zákazníkovi posielať tajné kľúče,
  // nechaj v .env.local iba verejné NEXT_PUBLIC_* hodnoty a OpenAI nech ide cez Supabase Edge Function.
  await copyIfExists(envLocalSrc, path.join(outDir, ".env.local"));
  await copyIfExists(envExampleSrc, path.join(outDir, ".env.example"));

  await writeFile(path.join(outDir, launcherName), runCmd, "utf8");
  // Backward-compatible launcher name for older instructions.
  await writeFile(path.join(outDir, "RUN_APP.cmd"), runCmd, "utf8");
  await writeFile(path.join(outDir, "STOP_APP.cmd"), stopCmd, "utf8");
  await writeFile(path.join(outDir, "README_INSTALL.txt"), readme, "utf8");

  console.log("Local release prepared:");
  console.log(path.relative(root, outDir));
}

main().catch((err) => {
  console.error("Release preparation failed:", err);
  process.exit(1);
});
