/**
 * NookNovel Web API Server
 * Converts Electron IPC handlers to REST API endpoints.
 * All logic ported from main.js (Electron backend).
 */

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

app.use(express.json({ limit: '100mb' }));
app.use(express.urlencoded({ extended: true, limit: '100mb' }));

// CORS for Firebase Hosting
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── DATA DIRECTORIES ──────────────────────────────────────────────────────────
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const BOOKS_FILE = path.join(DATA_DIR, 'translated_books.json');
const CREATOR_BOOKS_FILE = path.join(DATA_DIR, 'creator_books.json');
const CREATOR_CHAPTERS_FILE = path.join(DATA_DIR, 'creator_chapters.json');
const FIREBASE_CONFIG_FILE = path.join(DATA_DIR, 'firebase_config.json');
const FILES_DIR = path.join(DATA_DIR, 'uploaded_files');
const FILES_INDEX = path.join(DATA_DIR, 'files_index.json');

fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(FILES_DIR, { recursive: true });

const DEFAULT_FIREBASE_DATABASE_URL = process.env.FIREBASE_DB_URL ||
  'https://nooknovel-7b5a1-default-rtdb.asia-southeast1.firebasedatabase.app';

// ── UTILITY FUNCTIONS ─────────────────────────────────────────────────────────
function readJson(filePath, fallback = []) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) || fallback;
  } catch { return fallback; }
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function safeFirebasePath(value) {
  return String(value || '').trim().toLowerCase().replace(/[.$#[\]\/]/g, '_');
}

function normalizeFirebaseUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (!/^https:\/\/.+\.(firebaseio\.com|firebasedatabase\.app)$/i.test(parsed.origin)) {
      throw new Error('Invalid Firebase URL');
    }
    return parsed.origin.replace(/\/$/, '');
  } catch {
    throw new Error('Link Firebase Realtime Database không hợp lệ.');
  }
}

function getFirebaseDatabaseUrl() {
  const config = readJson(FIREBASE_CONFIG_FILE, {});
  return normalizeFirebaseUrl(config.databaseUrl || DEFAULT_FIREBASE_DATABASE_URL);
}

async function firebaseRequest(baseUrl, pathName, options = {}) {
  const url = `${baseUrl}/${pathName.replace(/^\/+/, '')}.json`;
  const method = options.method || 'GET';
  const body = options.body || '';

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'content-type': 'application/json' }, timeout: 30000 }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Firebase ${res.statusCode}: ${data}`));
        }
        try { resolve(data ? JSON.parse(data) : null); } catch { reject(new Error('Invalid JSON from Firebase')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('Firebase timeout')));
    req.on('error', e => reject(new Error(`Firebase error: ${e.message}`)));
    if (body) req.write(body);
    req.end();
  });
}

// ── PASSWORD HELPERS ──────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function isValidEmail(v) {
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(String(v || '').trim());
}

// ── USER MANAGEMENT (Firebase RTDB) ──────────────────────────────────────────
function normalizeUser(u) {
  return {
    email: String(u?.email || '').trim().toLowerCase(),
    displayName: String(u?.displayName || '').trim(),
    phone: String(u?.phone || '').trim(),
    bio: String(u?.bio || '').trim(),
    avatarUrl: String(u?.avatarUrl || '').trim(),
    favoriteGenre: String(u?.favoriteGenre || '').trim(),
    provider: String(u?.provider || 'local'),
    role: String(u?.role || 'user'),
    createdAt: u?.createdAt || new Date().toISOString(),
    updatedAt: u?.updatedAt || u?.createdAt || new Date().toISOString(),
    salt: u?.salt,
    passwordHash: u?.passwordHash
  };
}

function publicUserRecord(u) {
  const n = normalizeUser(u);
  const { salt, passwordHash, ...pub } = n;
  return pub;
}

async function fetchUsers() {
  try {
    const base = getFirebaseDatabaseUrl();
    const data = await firebaseRequest(base, 'novelReader/users', { method: 'GET' });
    if (!data) return [];
    return Object.values(data).map(normalizeUser);
  } catch { return []; }
}

async function saveUsers(users) {
  const base = getFirebaseDatabaseUrl();
  const obj = users.reduce((acc, u) => {
    const k = safeFirebasePath(u.email);
    if (k) acc[k] = normalizeUser(u);
    return acc;
  }, {});
  await firebaseRequest(base, 'novelReader/users', { method: 'PUT', body: JSON.stringify(obj) });
}

async function getUserByEmail(email) {
  const users = await fetchUsers();
  const norm = String(email || '').trim().toLowerCase();
  return users.find(u => u.email === norm) || null;
}

async function createUser(email, password, provider = 'local', role = 'user') {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) throw new Error('Email không hợp lệ.');
  if (norm !== 'admin' && !isValidEmail(norm)) throw new Error('Email không hợp lệ.');
  if (await getUserByEmail(norm)) throw new Error('Email này đã được sử dụng.');
  const user = { email: norm, displayName: '', phone: '', bio: '', avatarUrl: '', favoriteGenre: '', provider, role, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  if (provider === 'local') {
    if (!password) throw new Error('Mật khẩu là bắt buộc.');
    user.salt = generateSalt();
    user.passwordHash = hashPassword(password, user.salt);
  }
  const users = await fetchUsers();
  users.push(user);
  await saveUsers(users);
  return publicUserRecord(user);
}

async function updateUserProfile(email, profile = {}) {
  const norm = String(email || '').trim().toLowerCase();
  const users = await fetchUsers();
  const idx = users.findIndex(u => u.email === norm);
  if (idx === -1) throw new Error('Không tìm thấy tài khoản.');
  users[idx] = { ...normalizeUser(users[idx]), displayName: String(profile.displayName || '').trim().slice(0, 80), phone: String(profile.phone || '').trim().slice(0, 32), bio: String(profile.bio || '').trim().slice(0, 280), avatarUrl: String(profile.avatarUrl || '').trim().slice(0, 500), favoriteGenre: String(profile.favoriteGenre || '').trim().slice(0, 60), updatedAt: new Date().toISOString() };
  await saveUsers(users);
  return publicUserRecord(users[idx]);
}

async function resetLocalPassword(email, newPassword) {
  const norm = String(email || '').trim().toLowerCase();
  if (!norm) throw new Error('Email không hợp lệ.');
  if (!newPassword || newPassword.length < 6) throw new Error('Mật khẩu mới phải có ít nhất 6 ký tự.');
  const users = await fetchUsers();
  const idx = users.findIndex(u => u.email === norm);
  if (idx === -1) throw new Error('Không tìm thấy tài khoản.');
  if (users[idx].provider !== 'local') throw new Error('Tài khoản Google không dùng mật khẩu cục bộ.');
  const salt = generateSalt();
  users[idx] = { ...users[idx], salt, passwordHash: hashPassword(newPassword, salt) };
  await saveUsers(users);
  return publicUserRecord(users[idx]);
}

async function requireAdmin(email) {
  const u = await getUserByEmail(email);
  if (!u || u.role !== 'admin') throw new Error('Permission denied. Only admin can access this feature.');
  return u;
}

// Ensure admin user exists on startup
async function ensureAdminUser() {
  try {
    const users = await fetchUsers();
    let admin = users.find(u => u.email === 'admin');
    const defaultPwd = '123321Oki';
    if (!admin) {
      const salt = generateSalt();
      admin = { email: 'admin', provider: 'local', role: 'admin', createdAt: new Date().toISOString(), salt, passwordHash: hashPassword(defaultPwd, salt) };
      users.push(admin);
    } else {
      const salt = generateSalt();
      admin.salt = salt;
      admin.passwordHash = hashPassword(defaultPwd, salt);
      admin.role = 'admin';
      admin.provider = 'local';
    }
    await saveUsers(users);
    console.log('Admin user ensured.');
  } catch (e) { console.warn('ensureAdminUser failed:', e.message); }
}

// ── BOOK MANAGEMENT ───────────────────────────────────────────────────────────
function normalizeBook(book) {
  const chapters = Array.isArray(book.chapters) && book.chapters.length ? book.chapters : [{ id: 'chapter-1', title: 'Chapter 1', text: book.text || '', sourceText: '' }];
  const rp = book.readingProgress || { chapterIndex: 0, percent: 0, bookmarked: false };
  return { ...book, chapters, images: book.coverUrl ? [book.coverUrl] : [], coverUrl: book.coverUrl || '', text: book.text || chapters.map(c => c.text || '').join('\n\n'), translatedLength: book.translatedLength || chapters.reduce((t, c) => t + (c.text || '').length, 0), readingProgress: rp };
}

function publicBookMeta(book) {
  const n = normalizeBook(book);
  const chIdx = Math.min(n.chapters.length - 1, Math.max(0, n.readingProgress.chapterIndex || 0));
  const { text, chapters, ...meta } = n;
  return { ...meta, chapterCount: chapters.length, currentChapterTitle: chapters[chIdx]?.title || 'Chapter 1', readingPercent: n.readingProgress.percent || 0 };
}

function readBooks() { return readJson(BOOKS_FILE, []).map(normalizeBook); }
function writeBooks(books) { writeJson(BOOKS_FILE, books); }

async function autoSyncAllData() {
  try {
    const base = getFirebaseDatabaseUrl();
    const books = readBooks().map(normalizeBook);
    const updatedAt = new Date().toISOString();
    await firebaseRequest(base, 'novelReader/books', { method: 'PUT', body: JSON.stringify(books) });
    await firebaseRequest(base, 'novelReader/updatedAt', { method: 'PUT', body: JSON.stringify(updatedAt) });
    writeJson(FIREBASE_CONFIG_FILE, { databaseUrl: base, lastSyncAt: updatedAt });
    console.log('autoSync OK');
  } catch (e) { console.warn('autoSync failed:', e.message); }
}

// ── CREATOR ───────────────────────────────────────────────────────────────────
function readCreatorBooks() { return readJson(CREATOR_BOOKS_FILE, []); }
function writeCreatorBooks(b) { writeJson(CREATOR_BOOKS_FILE, b); }
function readCreatorChapters() { return readJson(CREATOR_CHAPTERS_FILE, []); }
function writeCreatorChapters(c) { writeJson(CREATOR_CHAPTERS_FILE, c); }

async function downloadFromUrl(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { timeout: 30000 }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function extractGoogleDriveIdFromLink(link) {
  const raw = String(link || '').trim();
  const match = raw.match(/\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw;
}

function extractGoogleDriveFolderIdFromLink(link) {
  const raw = String(link || '').trim();
  const match = raw.match(/\/folders\/([a-zA-Z0-9_-]+)/);
  return match ? match[1] : '';
}

async function resolveGoogleDrivePdfBuffer(link) {
  const folderId = extractGoogleDriveFolderIdFromLink(link);
  let driveId = extractGoogleDriveIdFromLink(link);

  if (folderId) {
    const folderHtml = (await downloadFromUrl(`https://drive.google.com/embeddedfolderview?id=${folderId}`)).toString('utf8');
    const fileMatches = [...folderHtml.matchAll(/\/file\/d\/([a-zA-Z0-9_-]+)/g)].map(match => match[1]);
    driveId = Array.from(new Set(fileMatches))[0] || '';
    if (!driveId) {
      throw new Error('Khong tim thay file PDF trong folder. Hay bat folder public hoac dan link truc tiep cua file PDF.');
    }
  }

  if (!driveId) throw new Error('Link Google Drive khong hop le.');
  const fileBuffer = await downloadFromUrl(`https://drive.google.com/uc?export=download&id=${driveId}`);
  const looksLikePdf = fileBuffer.length > 5 && fileBuffer.slice(0, 5).toString('utf8') === '%PDF-';
  if (!looksLikePdf) {
    throw new Error('Khong tai duoc file PDF. Hay dam bao link la file PDF public hoac folder public co file PDF.');
  }
  return { fileBuffer, driveId };
}

function splitPlainTextIntoChapters(text, chapterCount = 1) {
  const count = Math.max(1, Number(chapterCount) || 1);
  const cleaned = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];
  const paragraphs = cleaned.split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  const targetLength = Math.ceil(cleaned.length / count);
  const chapters = [];
  let current = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    if (chapters.length < count - 1 && current.length && currentLength + paragraph.length > targetLength) {
      chapters.push(current.join('\n\n'));
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraph.length + 2;
  }
  if (current.length) chapters.push(current.join('\n\n'));

  return chapters.map((chapterText, index) => ({
    id: `chapter-${index + 1}`,
    title: `Chapter ${index + 1}`,
    text: chapterText,
    sourceText: chapterText
  }));
}

async function renderPdfPageWithSpacing(pageData) {
  const textContent = await pageData.getTextContent({
    normalizeWhitespace: true,
    disableCombineTextItems: true
  });

  const lines = [];
  let currentLine = '';
  let lastY = null;
  let lastEndX = null;
  let lastFontSize = 10;

  for (const item of textContent.items || []) {
    const text = String(item.str || '');
    if (!text) continue;
    const transform = item.transform || [];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const fontSize = Math.max(1, Math.abs(Number(transform[0]) || Number(item.height) || lastFontSize || 10));
    const sameLine = lastY === null || Math.abs(y - lastY) <= Math.max(2, fontSize * 0.45);

    if (!sameLine) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
      lastEndX = null;
    }

    if (currentLine && lastEndX !== null) {
      const gap = x - lastEndX;
      const needsSpace = gap > Math.max(1.8, fontSize * 0.18)
        && !/\s$/.test(currentLine)
        && !/^[,.;:!?，。！？）」』\]\)]/.test(text);
      if (needsSpace) currentLine += ' ';
    }

    currentLine += text;
    lastY = y;
    lastFontSize = fontSize;
    lastEndX = x + (Number(item.width) || text.length * fontSize * 0.45);

    if (item.hasEOL) {
      if (currentLine.trim()) lines.push(currentLine.trim());
      currentLine = '';
      lastEndX = null;
      lastY = null;
    }
  }

  if (currentLine.trim()) lines.push(currentLine.trim());
  return lines.join('\n');
}

async function extractPdfTextFromBuffer(buffer) {
  const pdfResult = await pdfParse(buffer, { pagerender: renderPdfPageWithSpacing });
  return String(pdfResult?.text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── WebSocket broadcast ───────────────────────────────────────────────────────
function broadcast(msg) {
  const s = JSON.stringify(msg);
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(s); });
}

wss.on('connection', ws => {
  ws.on('error', () => { });
});

// ── FILES upload helper ───────────────────────────────────────────────────────
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// ─────────────────────────────────────────────────────────────────────────────
// UNIVERSAL IPC DISPATCH ROUTE
// POST /api/ipc/:channel  { args: [...] }
// This is what the ipcRenderer shim calls from the browser.
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/ipc/:channel', async (req, res) => {
  const { channel } = req.params;
  const args = Array.isArray(req.body.args) ? req.body.args : [];
  try {
    const result = await handleIpc(channel, args);
    res.json(result);
  } catch (err) {
    res.json({ ok: false, error: err.message || String(err) });
  }
});

async function handleIpc(channel, args) {
  switch (channel) {

    // ── AUTH ────────────────────────────────────────────────────────────────
    case 'auth-local-signup': {
      const [credOrEmail, pwd] = args;
      const email = typeof credOrEmail === 'object' ? credOrEmail.email : credOrEmail;
      const password = typeof credOrEmail === 'object' ? credOrEmail.password : pwd;
      if (!email || !password) throw new Error('Email và mật khẩu là bắt buộc.');
      const user = await createUser(email, password, 'local');
      setImmediate(() => autoSyncAllData());
      return { ok: true, user };
    }

    case 'auth-local-signin': {
      const [credOrEmail, pwd] = args;
      const email = typeof credOrEmail === 'object' ? credOrEmail.email : credOrEmail;
      const password = typeof credOrEmail === 'object' ? credOrEmail.password : pwd;
      if (!email || !password) throw new Error('Email và mật khẩu là bắt buộc.');
      const norm = String(email).trim().toLowerCase();
      const user = await getUserByEmail(norm);
      if (!user) return { ok: false, error: 'Email hoặc mật khẩu không đúng.' };
      if (user.provider !== 'local') return { ok: false, error: user.provider === 'google' ? 'Tài khoản này dùng Google để đăng nhập.' : 'Tài khoản không hỗ trợ mật khẩu cục bộ.' };
      const hash = hashPassword(password, user.salt || '');
      if (hash !== user.passwordHash) return { ok: false, error: 'Email hoặc mật khẩu không đúng.' };
      setImmediate(() => autoSyncAllData());
      return { ok: true, user: publicUserRecord(user) };
    }

    case 'auth-google-signin':
      // On web: Firebase Auth handles Google sign-in on the client side.
      // This channel returns a "use Firebase Auth" signal.
      return { ok: false, error: 'FIREBASE_AUTH', useFirebaseAuth: true };

    case 'auth-facebook-signin':
      return { ok: false, error: 'Facebook sign-in không khả dụng trên web.' };

    case 'auth-signout':
      return { ok: true };

    case 'auth-get-user': {
      const [email] = args;
      const user = await getUserByEmail(email);
      if (!user) return { ok: false, error: 'User not found.' };
      return { ok: true, user: publicUserRecord(user) };
    }

    case 'auth-update-profile': {
      const [payload = {}] = args;
      const user = await updateUserProfile(payload.email, payload.profile || payload);
      setImmediate(() => autoSyncAllData());
      return { ok: true, user };
    }

    case 'auth-reset-password': {
      const [payload, maybePassword] = args;
      const email = typeof payload === 'object' ? payload.email : payload;
      const password = typeof payload === 'object' ? (payload.password || payload.newPassword) : maybePassword;
      const user = await resetLocalPassword(email, password);
      return { ok: true, user };
    }

    case 'auth-clear-users': {
      const [currentEmail] = args;
      await requireAdmin(currentEmail);
      const users = await fetchUsers();
      const admin = users.find(u => u.role === 'admin');
      await saveUsers(admin ? [admin] : []);
      return { ok: true };
    }

    case 'auth-admin-list-users': {
      const [currentEmail] = args;
      const cu = await getUserByEmail(currentEmail);
      if (!cu || cu.role !== 'admin') return { ok: false, error: 'Permission denied.' };
      const users = (await fetchUsers()).filter(u => isValidEmail(u.email)).map(publicUserRecord);
      return { ok: true, users };
    }

    case 'auth-admin-delete-user': {
      const [targetEmail, currentEmail] = args;
      const cu = await getUserByEmail(currentEmail);
      if (!cu || cu.role !== 'admin') return { ok: false, error: 'Permission denied.' };
      const norm = String(targetEmail || '').trim().toLowerCase();
      if (!norm) return { ok: false, error: 'Target email is required.' };
      if (norm === 'admin') return { ok: false, error: 'Cannot delete admin account.' };
      const users = (await fetchUsers()).filter(u => u.email !== norm);
      await saveUsers(users);
      return { ok: true };
    }

    case 'auth-chrome-profile-info':
      return { ok: false, error: 'Desktop only feature.' };

    // ── BOOKS ───────────────────────────────────────────────────────────────
    case 'list-books':
      return readBooks().map(publicBookMeta);

    case 'get-book': {
      const [id] = args;
      const books = readBooks();
      const book = books.find(b => b.id === String(id));
      if (!book) return { ok: false, error: 'Không tìm thấy truyện.' };
      return { ok: true, book };
    }

    case 'delete-book': {
      const [id] = args;
      const books = readBooks().filter(b => b.id !== String(id));
      writeBooks(books);
      return books;
    }

    case 'save-reading-progress': {
      const [payload = {}] = args;
      const { id, bookId, chapterIndex, percent } = payload;
      const targetBookId = bookId || id;
      const books = readBooks();
      const idx = books.findIndex(b => b.id === String(targetBookId));
      if (idx !== -1) {
        books[idx].readingProgress = { chapterIndex: chapterIndex ?? 0, percent: percent ?? 0, bookmarked: books[idx].readingProgress?.bookmarked ?? false };
        writeBooks(books);
      }
      return readBooks().map(publicBookMeta);
    }

    case 'update-book-chapters': {
      const [payload = {}] = args;
      const { bookId, chapters } = payload;
      if (!bookId) throw new Error('ID truyện không hợp lệ.');
      if (!Array.isArray(chapters)) throw new Error('Danh sách chương không hợp lệ.');
      const books = readBooks();
      const idx = books.findIndex(b => b.id === bookId);
      if (idx === -1) throw new Error('Không tìm thấy truyện trong thư viện.');
      books[idx].chapters = chapters;
      const fullText = chapters.map(c => c.text || '').join('\n\n');
      books[idx].text = fullText;
      books[idx].translatedLength = fullText.length;
      books[idx] = normalizeBook(books[idx]);
      writeBooks(books);
      await autoSyncAllData();
      return { ok: true, book: books[idx] };
    }

    // ── FILES ───────────────────────────────────────────────────────────────
    case 'list-files':
      return readJson(FILES_INDEX, []);

    case 'list-books': // duplicate alias handled above
      return readBooks().map(publicBookMeta);

    case 'delete-file': {
      const [fileId, currentEmail] = args;
      await requireAdmin(currentEmail);
      const files = readJson(FILES_INDEX, []);
      const rec = files.find(f => f.id === fileId);
      if (!rec) throw new Error('File không tìm thấy.');
      const fpath = path.join(FILES_DIR, rec.fileName);
      if (fs.existsSync(fpath)) fs.unlinkSync(fpath);
      const next = files.filter(f => f.id !== fileId);
      writeJson(FILES_INDEX, next);
      return { ok: true, count: next.length };
    }

    case 'save-file-to-library': {
      // On web, files are managed via Firebase directly; stub for compatibility
      return { ok: false, error: 'Tính năng này yêu cầu desktop app để xử lý file cục bộ.' };
    }

    case 'push-google-drive-pdf-book': {
      const [payload = {}] = args;
      const { driveLink, title, chapterCount, currentEmail } = payload;
      await requireAdmin(currentEmail);

      const bookTitle = String(title || '').trim();
      if (!bookTitle) throw new Error('Vui long nhap ten truyen.');

      const { fileBuffer, driveId } = await resolveGoogleDrivePdfBuffer(driveLink);
      const extractedText = await extractPdfTextFromBuffer(fileBuffer);
      if (!extractedText || extractedText.length < 50) {
        throw new Error('PDF nay khong co text de trich xuat. Neu PDF la anh scan, can OCR truoc.');
      }

      const chapters = splitPlainTextIntoChapters(extractedText, chapterCount);
      if (!chapters.length) throw new Error('Khong chia duoc noi dung PDF thanh chuong.');

      const now = new Date();
      const book = normalizeBook({
        id: String(now.getTime()),
        title: bookTitle,
        sourceUrl: `https://drive.google.com/file/d/${driveId}/view`,
        coverUrl: '',
        images: [],
        chapters,
        readingProgress: { chapterIndex: 0, percent: 0, bookmarked: false },
        sourceLength: extractedText.length,
        translatedLength: extractedText.length,
        createdAt: now.toISOString(),
        text: chapters.map(c => c.text || '').join('\n\n')
      });

      const localBooks = readBooks();
      localBooks.unshift(book);
      writeBooks(localBooks);

      const base = getFirebaseDatabaseUrl();
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' }) || {};
      const remoteBooks = Array.isArray(data?.books) ? data.books : [];
      remoteBooks.unshift(book);
      const updatedAt = new Date().toISOString();
      await firebaseRequest(base, 'novelReader', { method: 'PUT', body: JSON.stringify({ ...data, updatedAt, books: remoteBooks }) });

      return {
        ok: true,
        book: publicBookMeta(book),
        books: readBooks().map(publicBookMeta),
        chapterCount: chapters.length,
        textLength: extractedText.length
      };
    }

    case 'upload-file':
    case 'upload-from-google-docs':
    case 'upload-from-google-drive':
      return { ok: false, error: 'Tải file: vui lòng dùng Desktop app hoặc tính năng Creator Space.' };

    // ── CATALOG (Discover) ──────────────────────────────────────────────────
    case 'load-catalog': {
      const [rawUrl] = args;
      const base = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' });
      const books = Array.isArray(data?.books) ? data.books.map(normalizeBook) : [];
      return { ok: true, books: books.map(b => ({ id: b.id, title: b.title || 'Truyện không tên', coverUrl: b.coverUrl || '', chapterCount: (b.chapters || []).length, sourceUrl: b.sourceUrl || '', description: b.description || '' })) };
    }

    case 'pull-single-book': {
      const [rawUrl, bookId, currentEmail] = args;
      if (!currentEmail) throw new Error('Bạn cần đăng nhập để tải truyện.');
      if (!bookId) throw new Error('ID truyện không hợp lệ.');
      const base = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' });
      const remoteBooks = Array.isArray(data?.books) ? data.books : [];
      const remote = remoteBooks.find(b => b.id === bookId);
      if (!remote) throw new Error('Không tìm thấy truyện này trên Firebase.');
      const norm = normalizeBook(remote);
      const localBooks = readBooks();
      const ei = localBooks.findIndex(b => b.id === bookId);
      if (ei >= 0) localBooks[ei] = norm; else localBooks.push(norm);
      writeBooks(localBooks);
      return { ok: true, book: publicBookMeta(norm) };
    }

    case 'admin-delete-remote-book': {
      const [rawUrl, bookId, currentEmail] = args;
      await requireAdmin(currentEmail);
      if (!bookId) throw new Error('ID truyện không hợp lệ.');
      const base = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' });
      const remoteBooks = Array.isArray(data?.books) ? data.books : [];
      const next = remoteBooks.filter(b => b.id !== bookId);
      await firebaseRequest(base, 'novelReader', { method: 'PUT', body: JSON.stringify({ ...data, updatedAt: new Date().toISOString(), books: next }) });
      return { ok: true, count: next.length };
    }

    // ── SYNC ────────────────────────────────────────────────────────────────
    case 'sync-to-firebase': {
      const [rawUrl, currentEmail] = args;
      await requireAdmin(currentEmail);
      const base = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
      const books = readBooks().map(normalizeBook);
      const updatedAt = new Date().toISOString();
      await firebaseRequest(base, 'novelReader/books', { method: 'PUT', body: JSON.stringify(books) });
      await firebaseRequest(base, 'novelReader/updatedAt', { method: 'PUT', body: JSON.stringify(updatedAt) });
      writeJson(FIREBASE_CONFIG_FILE, { databaseUrl: base, lastSyncAt: updatedAt });
      return { ok: true, count: books.length, updatedAt };
    }

    case 'pull-from-firebase': {
      const [rawUrl, currentEmail] = args;
      if (!currentEmail) throw new Error('Bạn cần đăng nhập để kéo truyện từ Firebase.');
      const base = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' });
      const remoteBooks = Array.isArray(data?.books) ? data.books.map(normalizeBook) : [];
      writeBooks(remoteBooks);
      writeJson(FIREBASE_CONFIG_FILE, { databaseUrl: base, lastPullAt: new Date().toISOString() });
      return { ok: true, count: remoteBooks.length, books: remoteBooks.map(publicBookMeta) };
    }

    case 'get-firebase-config':
      return { databaseUrl: DEFAULT_FIREBASE_DATABASE_URL, ...readJson(FIREBASE_CONFIG_FILE, {}) };

    // ── CREATOR ─────────────────────────────────────────────────────────────
    case 'creator-list-books':
      return { ok: true, books: readCreatorBooks() };

    case 'creator-create-book': {
      const [payload = {}] = args;
      const { title, description, currentEmail } = payload;
      await requireAdmin(currentEmail);
      if (!title) throw new Error('Tiêu đề truyện không được để trống.');
      const books = readCreatorBooks();
      const newBook = { id: `book_${Date.now()}`, title, coverUrl: '', description: description || '', createdAt: new Date().toISOString() };
      books.push(newBook);
      writeCreatorBooks(books);
      return { ok: true, book: newBook };
    }

    case 'creator-list-chapters': {
      const [payload = {}] = args;
      const { bookId } = payload;
      const all = readCreatorChapters();
      const filtered = (bookId ? all.filter(c => c.bookId === bookId) : all)
        .sort((a, b) => (Number(a.chapterNumber) || 0) - (Number(b.chapterNumber) || 0));
      return { ok: true, chapters: filtered };
    }

    case 'creator-add-chapter': {
      const [payload = {}] = args;
      const { bookId, chapterNumber, chapterName, contentUrlOrLink, currentEmail } = payload;
      await requireAdmin(currentEmail);
      if (!bookId) throw new Error('Vui lòng chọn quyển truyện.');
      if (!chapterNumber) throw new Error('Vui lòng nhập số chương.');
      if (!chapterName) throw new Error('Vui lòng nhập tên chương.');
      const chapters = readCreatorChapters();
      const newCh = { id: `chapter_${Date.now()}`, bookId, chapterNumber, chapterName, contentUrlOrLink: contentUrlOrLink || '', imageUrl: '', createdAt: new Date().toISOString() };
      chapters.push(newCh);
      writeCreatorChapters(chapters);
      return { ok: true, chapter: newCh };
    }

    case 'creator-delete-chapter': {
      const [payload = {}] = args;
      const { chapterId, currentEmail } = payload;
      await requireAdmin(currentEmail);
      if (!chapterId) throw new Error('ID chương không hợp lệ.');
      const chs = readCreatorChapters();
      const idx = chs.findIndex(c => c.id === chapterId);
      if (idx === -1) throw new Error('Không tìm thấy chương cần xóa.');
      chs.splice(idx, 1);
      writeCreatorChapters(chs);
      return { ok: true };
    }

    case 'creator-update-chapters-order': {
      const [payload = {}] = args;
      const { bookId, chapterIds, currentEmail } = payload;
      await requireAdmin(currentEmail);
      if (!bookId) throw new Error('ID truyện không hợp lệ.');
      if (!Array.isArray(chapterIds)) throw new Error('Danh sách thứ tự không hợp lệ.');
      const chs = readCreatorChapters();
      const bookChs = chs.filter(c => c.bookId === bookId);
      const others = chs.filter(c => c.bookId !== bookId);
      const chMap = new Map(bookChs.map(c => [c.id, c]));
      const sorted = [];
      chapterIds.forEach((id, i) => { const c = chMap.get(id); if (c) { c.chapterNumber = i + 1; sorted.push(c); } });
      bookChs.forEach(c => { if (!chapterIds.includes(c.id)) { c.chapterNumber = sorted.length + 1; sorted.push(c); } });
      writeCreatorChapters([...others, ...sorted]);
      return { ok: true };
    }

    case 'creator-push-to-discovery': {
      const [payload = {}] = args;
      const { bookId, currentEmail } = payload;
      await requireAdmin(currentEmail);
      if (!bookId) throw new Error('ID truyện không hợp lệ.');
      const creatorBooks = readCreatorBooks();
      const creatorBook = creatorBooks.find(b => b.id === bookId);
      if (!creatorBook) throw new Error('Không tìm thấy truyện trong Creator Space.');
      const chs = readCreatorChapters().filter(c => c.bookId === bookId)
        .sort((a, b) => Number(a.chapterNumber) - Number(b.chapterNumber));

      const mappedChapters = await Promise.all(chs.map(async ch => {
        let text = '';
        const link = ch.contentUrlOrLink || '';
        if (link.startsWith('https://docs.google.com')) {
          try {
            const m = link.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
            if (m) {
              const buf = await downloadFromUrl(`https://docs.google.com/document/d/${m[1]}/export?format=txt`);
              const t = buf.toString('utf8').trim();
              if (t && !t.startsWith('<!DOCTYPE') && !t.startsWith('<html')) text = t;
            }
          } catch { text = '[Lỗi tải Google Docs]'; }
        } else if (link.includes('drive.google.com')) {
          try {
            const { fileBuffer } = await resolveGoogleDrivePdfBuffer(link);
            text = await extractPdfTextFromBuffer(fileBuffer);
            if (!text) text = '[PDF này không có text để đọc. Nếu PDF là ảnh scan, cần OCR trước.]';
          } catch (error) {
            text = `[Lỗi tải Google Drive PDF: ${error.message || String(error)}]`;
          }
        } else if (link) {
          text = `[Liên kết bản thảo: ${link}]`;
        } else {
          text = '[Chưa có nội dung]';
        }
        return { id: ch.id, title: `Chương ${ch.chapterNumber}: ${ch.chapterName}`, text, imageUrl: ch.imageUrl || '' };
      }));

      const standardBook = { id: `creator_${creatorBook.id}`, title: creatorBook.title, coverUrl: creatorBook.coverUrl, description: creatorBook.description, chapters: mappedChapters, createdAt: creatorBook.createdAt || new Date().toISOString(), sourceUrl: 'Creator Space', text: mappedChapters.map(c => c.text).join('\n\n') };
      const base = getFirebaseDatabaseUrl();
      const data = await firebaseRequest(base, 'novelReader', { method: 'GET' }) || {};
      const remoteBooks = Array.isArray(data?.books) ? data.books : [];
      const ei = remoteBooks.findIndex(b => b.id === standardBook.id);
      if (ei >= 0) remoteBooks[ei] = standardBook; else remoteBooks.push(standardBook);
      await firebaseRequest(base, 'novelReader', { method: 'PUT', body: JSON.stringify({ ...data, updatedAt: new Date().toISOString(), books: remoteBooks }) });
      const lb = readBooks();
      const li = lb.findIndex(b => b.id === standardBook.id);
      if (li >= 0) lb[li] = normalizeBook(standardBook); else lb.push(normalizeBook(standardBook));
      writeBooks(lb);
      return { ok: true, count: remoteBooks.length };
    }

    // ── AUTOMATION (Desktop only) ────────────────────────────────────────────
    case 'run-automation':
    case 'setup-gemini-session':
      return { ok: false, error: 'Tính năng này chỉ có trong Desktop app (Electron). Trên web, vui lòng tải EXE về để dịch truyện tự động.', desktopOnly: true };

    default:
      return { ok: false, error: `Unknown IPC channel: ${channel}` };
  }
}

// ── STATIC FILES ──────────────────────────────────────────────────────────────
const clientDir = path.join(__dirname, '..', 'client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('*', (req, res, next) => {
    if (req.method === 'GET' && req.headers.accept?.includes('text/html')) {
      const indexPath = path.join(clientDir, 'index.html');
      if (fs.existsSync(indexPath)) return res.sendFile(indexPath);
    }
    next();
  });
}

app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

// ── START SERVER ──────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

ensureAdminUser().then(() => {
  server.listen(PORT, () => console.log(`NookNovel API Server running on port ${PORT}`));
});
