# CAP Leaflet Editor - Standalone Version

## For You (Developer)

To run locally:
```bash
npm run build
node server.js
```

Then open: http://localhost:3000

## For Your Customers

### Option 1: Simple (Recommended)

1. Ensure Node.js is installed: https://nodejs.org/ (v20+)
2. Extract the application folder
3. **Double-click `START.bat`** 
4. Wait for message "Your application is ready!"
5. Open browser: http://localhost:3000

### Option 2: Share Over Network

Same as Option 1, but share the **Network URL** (e.g., `http://192.168.1.100:3000`) with customers on the same WiFi/LAN.

They can access from their computers/phones on the same network!

### Option 3: Docker (No Node.js needed)

If customers have Docker:
```bash
docker build -t cap-leaflet-editor .
docker run -p 3000:3000 cap-leaflet-editor
```

---

## What's Inside

- `.next/` — Optimized production build of the application
- `server.js` — Starts the Next.js server
- `START.bat` — One-click startup (Windows)
- `package.json` — Dependencies information

## Features

✅ Generate promotional flyers in JSON format  
✅ Upload flyers to cloud storage  
✅ Multi-language support (SK/CZ/PL)  
✅ AI PDF import (detects products, prices, dates)  
✅ Works offline (after first start)  

## Troubleshooting

**"Node.js is not installed"**
- Download from: https://nodejs.org/
- Click "LTS" version and install

**"Cannot find .next directory"**
- Run in original application directory
- Or rebuild: `npm run build`

**Port 3000 already in use**
- Edit `server.js` and change PORT to 3001, 3002, etc.

**Can't connect from another computer**
- Make sure both computers are on the same network
- Use the Network URL shown in terminal

---

**Questions?** Contact support or refer to main repository.
