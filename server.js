const { spawn } = require("child_process");
const path = require("path");
const os = require("os");

// Start Next.js standalone server
const standaloneDir = path.join(__dirname, ".next", "standalone");
const env = process.env;
env.PORT = process.env.PORT || 3000;

const server = spawn("node", ["server.js"], {
  cwd: standaloneDir,
  stdio: "inherit",
  env,
});

server.on("error", (err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});

server.on("close", (code) => {
  console.log(`Server exited with code ${code}`);
  process.exit(code);
});

// Print startup info
setTimeout(() => {
  const hostname = os.hostname();
  const ipv4 = Object.values(os.networkInterfaces())
    .flat()
    .find((iface) => iface.family === "IPv4" && !iface.internal)?.address;
  
  console.log("\n✅ CAP Leaflet Editor ready!");
  console.log(`📍 Local:   http://localhost:3000`);
  console.log(`📍 Network: http://${ipv4}:3000`);
  console.log("\n💡 Share the Network URL with your customers\n");
}, 2000);
