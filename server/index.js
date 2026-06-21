const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());

// Serve built client if exists
const clientDist = path.join(__dirname, '..', 'client', 'dist');
app.use(express.static(clientDist));
app.get('*', (req, res, next) => {
  const index = path.join(clientDist, 'index.html');
  if (req.method === 'GET' && req.headers.accept && req.headers.accept.includes('text/html')) {
    res.sendFile(index, err => { if (err) next(); });
  } else next();
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Admin endpoint to force sync server/novels -> Firestore
app.post('/admin/sync', async (req, res) => {
  const provided = req.headers['x-admin-secret'] || req.body && req.body.secret;
  if (!process.env.ADMIN_SECRET) return res.status(500).json({ error: 'ADMIN_SECRET not configured on server' });
  if (!provided || provided !== process.env.ADMIN_SECRET) return res.status(403).json({ error: 'forbidden' });
  if (!db) return res.status(500).json({ error: 'Firestore not initialized on server' });

  try {
    if (!fs.existsSync(novelsDir)) return res.status(400).json({ error: 'novels dir missing' });
    const files = fs.readdirSync(novelsDir).filter(f => f.endsWith('.txt'));
    const results = [];
    for (const file of files) {
      const title = path.basename(file, '.txt');
      const full = path.join(novelsDir, file);
      const content = fs.readFileSync(full, 'utf8');
      await db.collection('novels').doc(title).set({ title, content, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      results.push(title);
      broadcast({ type: 'novel-update', id: title, content });
    }
    return res.json({ ok: true, uploaded: results.length, titles: results });
  } catch (e) {
    console.warn('Admin sync failed', e);
    return res.status(500).json({ error: e.message || '' });
  }
});

// Firestore admin (optional)
let admin = null;
let db = null;
const saPath = path.join(__dirname, 'serviceAccountKey.json');
// Support loading Firebase service account from an environment variable so
// secrets do not need to be committed. If `FIREBASE_SERVICE_ACCOUNT` is set
// it should contain the JSON string of the service account key.
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const parsed = typeof process.env.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
        : process.env.FIREBASE_SERVICE_ACCOUNT;
      fs.writeFileSync(saPath, JSON.stringify(parsed, null, 2), { encoding: 'utf8' });
      console.log('Wrote Firebase service account JSON to', saPath);
    } catch (e) {
      console.warn('Could not parse FIREBASE_SERVICE_ACCOUNT:', e.message);
    }
  }

  if (fs.existsSync(saPath)) {
    try {
      admin = require('firebase-admin');
      admin.initializeApp({ credential: admin.credential.cert(require(saPath)) });
      db = admin.firestore();
      console.log('Initialized firebase-admin for Firestore sync');
    } catch (e) {
      console.warn('Failed to init firebase-admin:', e.message);
    }
  }
} catch (e) {
  console.warn('Firebase service account setup skipped:', e.message);
}

// Broadcast helper
function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

wss.on('connection', (ws) => {
  console.log('WebSocket client connected');
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'read') {
        // If Firestore available, try to fetch content
        if (db && typeof data.id === 'string') {
          db.collection('novels').doc(data.id).get().then(doc => {
            if (doc.exists) ws.send(JSON.stringify({ type: 'novel', id: data.id, text: doc.data().content }));
            else ws.send(JSON.stringify({ type: 'error', message: 'Not found' }));
          }).catch(err => ws.send(JSON.stringify({ type: 'error', message: err.message })));
        } else {
          // Fallback: send sample
          ws.send(JSON.stringify({ type: 'novel', text: 'Đây là đoạn mẫu từ server: Chương 1...' }));
        }
      }
    } catch (e) { console.error('Invalid message', e); }
  });
});

// Watch novels directory and sync to Firestore + notify clients
const novelsDir = path.join(__dirname, 'novels');
if (fs.existsSync(novelsDir) && db) {
  // initial upload
  fs.readdirSync(novelsDir).filter(f => f.endsWith('.txt')).forEach(file => {
    const title = path.basename(file, '.txt');
    const content = fs.readFileSync(path.join(novelsDir, file), 'utf8');
    db.collection('novels').doc(title).set({ title, content, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).catch(e=>console.warn('Upload failed',e));
  });

  // watcher with debounce
  const pending = new Map();
  function scheduleUpload(file) {
    if (pending.has(file)) clearTimeout(pending.get(file));
    const t = setTimeout(() => {
      pending.delete(file);
      try {
        const title = path.basename(file, '.txt');
        const full = path.join(novelsDir, file);
        if (fs.existsSync(full)) {
          const content = fs.readFileSync(full, 'utf8');
          db.collection('novels').doc(title).set({ title, content, updatedAt: admin.firestore.FieldValue.serverTimestamp() }).then(()=>{
            console.log('Synced', title);
            broadcast({ type: 'novel-update', id: title, content });
          }).catch(e=>console.warn('Sync failed', e));
        }
      } catch (e) { console.warn('Watcher error', e); }
    }, 300);
    pending.set(file, t);
  }

  fs.watch(novelsDir, (ev, filename) => { if (filename && filename.endsWith('.txt')) scheduleUpload(filename); });
  console.log('Watching novels dir for changes');
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Server listening on ${PORT}`));