const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const puppeteer = require('puppeteer-core');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');

const CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const GEMINI_URL = 'https://gemini.google.com/app?hl=vi';
const DEFAULT_FIREBASE_DATABASE_URL = 'https://nooknovel-7b5a1-default-rtdb.asia-southeast1.firebasedatabase.app';
const SESSION_DIR = path.join(app.getPath('userData'), 'gemini_session');
const CHROME_USER_DATA_DIR = path.join(process.env.LOCALAPPDATA || app.getPath('home'), 'Google', 'Chrome', 'User Data');
const CHROME_PROFILE_DIR = 'Default';
const BOOKS_FILE = path.join(app.getPath('userData'), 'translated_books.json');
const USERS_FILE = path.join(app.getPath('userData'), 'users.json');
const FIREBASE_CONFIG_FILE = path.join(app.getPath('userData'), 'firebase_config.json');
const FILES_DIR = path.join(app.getPath('userData'), 'uploaded_files');
const FILES_INDEX = path.join(app.getPath('userData'), 'files_index.json');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#0f1115',
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  mainWindow.loadFile('index.html');
}

app.whenReady().then(async () => {
  try {
    await ensureAdminUser();
  } catch (error) {
    console.warn('Unable to initialize admin user in Firebase:', error && error.message ? error.message : String(error));
  }
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

function sendProgress(message, progress) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('automation-progress', {
      message,
      progress: Math.max(0, Math.min(100, progress))
    });
  }
}

function assertChromeExists() {
  if (!fs.existsSync(CHROME_PATH)) {
    throw new Error(`Không tìm thấy Google Chrome tại: ${CHROME_PATH}`);
  }
}

function getLatestChromeProfileInfo() {
  const fallback = {
    profileDir: CHROME_PROFILE_DIR,
    profilePath: path.join(CHROME_USER_DATA_DIR, CHROME_PROFILE_DIR),
    source: 'default'
  };

  try {
    const localStatePath = path.join(CHROME_USER_DATA_DIR, 'Local State');
    if (fs.existsSync(localStatePath)) {
      const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
      const profiles = localState?.profile?.last_active_profiles;
      if (Array.isArray(profiles) && profiles[0]) {
        const profileDir = String(profiles[0]);
        return {
          profileDir,
          profilePath: path.join(CHROME_USER_DATA_DIR, profileDir),
          source: 'last_active_profiles'
        };
      }
    }

    const candidates = fs.readdirSync(CHROME_USER_DATA_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && (entry.name === 'Default' || /^Profile \d+$/i.test(entry.name)))
      .map((entry) => {
        const profilePath = path.join(CHROME_USER_DATA_DIR, entry.name);
        const stat = fs.statSync(profilePath);
        return { profileDir: entry.name, profilePath, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    if (candidates[0]) {
      return { ...candidates[0], source: 'recent_folder' };
    }
  } catch (error) {
    console.warn('Cannot detect latest Chrome profile:', error && error.message ? error.message : String(error));
  }

  return fallback;
}

function normalizeBook(book) {
  const chapters = Array.isArray(book.chapters) && book.chapters.length
    ? book.chapters
    : [{
      id: 'chapter-1',
      title: 'Chapter 1',
      text: book.text || '',
      sourceText: ''
    }];

  const readingProgress = book.readingProgress || {
    chapterIndex: 0,
    percent: 0,
    bookmarked: false
  };

  return {
    ...book,
    chapters,
    images: book.coverUrl ? [book.coverUrl] : [],
    coverUrl: book.coverUrl || '',
    text: book.text || chapters.map((chapter) => chapter.text || '').join('\n\n'),
    translatedLength: book.translatedLength || chapters.reduce((total, chapter) => total + (chapter.text || '').length, 0),
    readingProgress
  };
}

function publicBookMeta(book) {
  const normalized = normalizeBook(book);
  const chapterIndex = Math.min(
    normalized.chapters.length - 1,
    Math.max(0, normalized.readingProgress.chapterIndex || 0)
  );

  const { text, chapters, ...meta } = normalized;
  return {
    ...meta,
    chapterCount: chapters.length,
    currentChapterTitle: chapters[chapterIndex]?.title || 'Chapter 1',
    readingPercent: normalized.readingProgress.percent || 0
  };
}

function readBooks() {
  try {
    if (!fs.existsSync(BOOKS_FILE)) return [];
    const raw = fs.readFileSync(BOOKS_FILE, 'utf8');
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data.map(normalizeBook) : [];
  } catch {
    return [];
  }
}

function writeBooks(books) {
  fs.mkdirSync(path.dirname(BOOKS_FILE), { recursive: true });
  fs.writeFileSync(BOOKS_FILE, JSON.stringify(books, null, 2), 'utf8');
}

function readFilesIndex() {
  try {
    if (!fs.existsSync(FILES_INDEX)) return [];
    const raw = fs.readFileSync(FILES_INDEX, 'utf8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function writeFilesIndex(files) {
  fs.mkdirSync(path.dirname(FILES_INDEX), { recursive: true });
  fs.mkdirSync(FILES_DIR, { recursive: true });
  fs.writeFileSync(FILES_INDEX, JSON.stringify(files, null, 2), 'utf8');
}

async function fetchUsersFromFirebase() {
  try {
    const baseUrl = getFirebaseDatabaseUrl();
    const data = await firebaseRequest(baseUrl, 'novelReader/users', { method: 'GET' });
    if (!data) return [];
    if (Array.isArray(data)) {
      return data.map(normalizeUser);
    }
    return Object.values(data || {}).map(normalizeUser);
  } catch {
    return [];
  }
}

function normalizeUser(user) {
  return {
    email: String(user?.email || '').trim().toLowerCase(),
    displayName: String(user?.displayName || '').trim(),
    phone: String(user?.phone || '').trim(),
    bio: String(user?.bio || '').trim(),
    avatarUrl: String(user?.avatarUrl || '').trim(),
    favoriteGenre: String(user?.favoriteGenre || '').trim(),
    provider: String(user?.provider || 'local'),
    role: String(user?.role || 'user'),
    createdAt: user?.createdAt || new Date().toISOString(),
    updatedAt: user?.updatedAt || user?.createdAt || new Date().toISOString(),
    salt: user?.salt,
    passwordHash: user?.passwordHash
  };
}

function usersToFirebaseObject(users) {
  return users.reduce((result, user) => {
    const normalizedEmail = String(user?.email || '').trim().toLowerCase();
    if (!normalizedEmail) return result;
    const key = safeFirebasePath(normalizedEmail);
    if (!key) return result;
    result[key] = normalizeUser(user);
    return result;
  }, {});
}

async function readUsers() {
  return await fetchUsersFromFirebase();
}

async function writeUsers(users) {
  const baseUrl = getFirebaseDatabaseUrl();
  const usersObject = usersToFirebaseObject(users);
  await firebaseRequest(baseUrl, 'novelReader/users', {
    method: 'PUT',
    body: JSON.stringify(usersObject)
  });
}

async function clearUsers({ preserveAdmin = true } = {}) {
  if (!preserveAdmin) {
    await writeUsers([]);
    return;
  }

  const users = await readUsers();
  const adminUser = users.find((user) => user.role === 'admin');
  const remaining = adminUser ? [adminUser] : [];
  await writeUsers(remaining);
}

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}

function generateSalt() {
  return crypto.randomBytes(16).toString('hex');
}

function isValidEmail(value) {
  const email = String(value || '').trim();
  return /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(email);
}

async function getUserByEmail(email) {
  const users = await readUsers();
  return users.find((user) => user.email.toLowerCase() === String(email || '').trim().toLowerCase()) || null;
}

async function createUser(email, password, provider = 'local', role = 'user') {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Email không hợp lệ.');
  }
  if (normalizedEmail !== 'admin' && !isValidEmail(normalizedEmail)) {
    throw new Error('Email không hợp lệ.');
  }
  if (await getUserByEmail(normalizedEmail)) {
    throw new Error('Email này đã được sử dụng.');
  }

  const user = {
    email: normalizedEmail,
    displayName: '',
    phone: '',
    bio: '',
    avatarUrl: '',
    favoriteGenre: '',
    provider,
    role,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  if (provider === 'local') {
    if (!password) {
      throw new Error('Mật khẩu là bắt buộc cho đăng ký cục bộ.');
    }
    const salt = generateSalt();
    const passwordHash = hashPassword(password, salt);
    user.salt = salt;
    user.passwordHash = passwordHash;
  }

  const users = await readUsers();
  users.push(user);
  await writeUsers(users);
  return publicUserRecord(user);
}

async function verifyUser(email, password) {
  const user = await getUserByEmail(email);
  if (!user || user.provider !== 'local' || !user.salt || !user.passwordHash) return null;
  const passwordHash = hashPassword(password, user.salt);
  return passwordHash === user.passwordHash
    ? { email: user.email, createdAt: user.createdAt, provider: user.provider, role: user.role || 'user' }
    : null;
}

async function resetLocalPassword(email, newPassword) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const password = String(newPassword || '');

  if (!normalizedEmail) {
    throw new Error('Email không hợp lệ.');
  }
  if (password.length < 6) {
    throw new Error('Mật khẩu mới phải có ít nhất 6 ký tự.');
  }

  const users = await readUsers();
  const userIndex = users.findIndex((item) => item.email.toLowerCase() === normalizedEmail);
  if (userIndex === -1) {
    throw new Error('Không tìm thấy tài khoản.');
  }

  const current = users[userIndex];
  if (current.provider !== 'local') {
    throw new Error('Tài khoản Google không dùng mật khẩu cục bộ.');
  }

  const salt = generateSalt();
  const updated = {
    ...current,
    salt,
    passwordHash: hashPassword(password, salt)
  };

  users[userIndex] = updated;
  await writeUsers(users);
  return publicUserRecord(updated);
}

function publicUserRecord(user) {
  return {
    email: user.email,
    displayName: user.displayName || '',
    phone: user.phone || '',
    bio: user.bio || '',
    avatarUrl: user.avatarUrl || '',
    favoriteGenre: user.favoriteGenre || '',
    createdAt: user.createdAt,
    updatedAt: user.updatedAt || user.createdAt,
    provider: user.provider || 'local',
    role: user.role || 'user'
  };
}

async function getUserRecordByEmail(email) {
  const user = await getUserByEmail(email);
  return user ? publicUserRecord(user) : null;
}

async function updateUserProfile(email, profile = {}) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!normalizedEmail) {
    throw new Error('Email không hợp lệ.');
  }

  const users = await readUsers();
  const userIndex = users.findIndex((item) => item.email.toLowerCase() === normalizedEmail);
  if (userIndex === -1) {
    throw new Error('Không tìm thấy tài khoản.');
  }

  const current = normalizeUser(users[userIndex]);
  const updated = {
    ...current,
    displayName: String(profile.displayName || '').trim().slice(0, 80),
    phone: String(profile.phone || '').trim().slice(0, 32),
    bio: String(profile.bio || '').trim().slice(0, 280),
    avatarUrl: String(profile.avatarUrl || '').trim().slice(0, 500),
    favoriteGenre: String(profile.favoriteGenre || '').trim().slice(0, 60),
    updatedAt: new Date().toISOString()
  };

  users[userIndex] = updated;
  await writeUsers(users);
  return publicUserRecord(updated);
}

async function deleteUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const users = (await readUsers()).filter((user) => user.email.toLowerCase() !== normalized);
  await writeUsers(users);
}

async function ensureAdminUser() {
  const adminEmail = 'admin';
  const defaultAdminPassword = '123321Oki';

  if (fs.existsSync(USERS_FILE)) {
    try {
      fs.unlinkSync(USERS_FILE);
    } catch {
      // ignore local cleanup errors
    }
  }

  const users = await readUsers();
  let adminUser = users.find((user) => user.email.toLowerCase() === adminEmail);
  if (!adminUser) {
    const salt = generateSalt();
    adminUser = {
      email: adminEmail,
      provider: 'local',
      role: 'admin',
      createdAt: new Date().toISOString(),
      salt,
      passwordHash: hashPassword(defaultAdminPassword, salt)
    };
    users.push(adminUser);
    await writeUsers(users);
  } else {
    const salt = adminUser.salt || generateSalt();
    adminUser.salt = salt;
    adminUser.passwordHash = hashPassword(defaultAdminPassword, salt);
    adminUser.role = 'admin';
    adminUser.provider = 'local';
    await writeUsers(users);
  }
}

async function requireAdminUser(currentEmail) {
  const currentUser = await getUserByEmail(currentEmail);
  if (!currentUser || currentUser.role !== 'admin') {
    throw new Error('Permission denied. Only admin can access this feature.');
  }
  return currentUser;
}

async function ensureRemoteUser(user) {
  const existing = await getUserByEmail(user.email);
  if (existing) return publicUserRecord(existing);
  return await createUser(user.email, null, user.provider || 'google');
}

function safeFirebasePath(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return '';
  return raw.replace(/[.$#[\]\/]/g, '_');
}

function getFirebaseDatabaseUrl() {
  const config = readFirebaseConfig();
  return normalizeFirebaseUrl(config.databaseUrl || DEFAULT_FIREBASE_DATABASE_URL);
}

async function autoSyncAllData() {
  try {
    const baseUrl = getFirebaseDatabaseUrl();
    const books = readBooks().map(normalizeBook);
    const users = (await readUsers()).map(publicUserRecord);
    const payload = {
      updatedAt: new Date().toISOString(),
      books,
      users
    };

    await firebaseRequest(baseUrl, 'novelReader', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    writeFirebaseConfig({ databaseUrl: baseUrl, lastSyncAt: payload.updatedAt });
    console.log('autoSyncAllData: Sync thành công');
  } catch (error) {
    console.warn('autoSyncAllData failed (non-critical):', error && error.message ? error.message : String(error));
  }
}

async function syncUserToFirebase(user) {
  try {
    const baseUrl = getFirebaseDatabaseUrl();
    const userKey = safeFirebasePath(user.email);
    await firebaseRequest(baseUrl, `novelReader/users/${userKey}`, {
      method: 'PUT',
      body: JSON.stringify(publicUserRecord(user))
    });
  } catch (error) {
    console.warn('syncUserToFirebase failed:', error && error.message ? error.message : String(error));
  }
}

async function mergeRemoteUsers(remoteUsers) {
  const existingUsers = await readUsers();
  const normalizedMap = new Map(existingUsers.map((user) => [user.email.toLowerCase(), user]));
  const remoteList = Array.isArray(remoteUsers)
    ? remoteUsers
    : Object.values(remoteUsers || {});

  for (const remote of remoteList) {
    if (!remote || !remote.email) continue;
    const email = String(remote.email).trim().toLowerCase();
    if (normalizedMap.has(email)) continue;
    normalizedMap.set(email, {
      email,
      provider: remote.provider || 'local',
      createdAt: remote.createdAt || new Date().toISOString()
    });
  }

  return Array.from(normalizedMap.values());
}

function readFirebaseConfig() {
  try {
    if (!fs.existsSync(FIREBASE_CONFIG_FILE)) return {};
    return JSON.parse(fs.readFileSync(FIREBASE_CONFIG_FILE, 'utf8')) || {};
  } catch {
    return {};
  }
}

function writeFirebaseConfig(config) {
  fs.mkdirSync(path.dirname(FIREBASE_CONFIG_FILE), { recursive: true });
  fs.writeFileSync(FIREBASE_CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

function saveBook({ sourceUrl, chapters, coverUrl, extractedTitle }) {
  const books = readBooks();
  const now = new Date();
  const title = extractedTitle || buildBookTitle(sourceUrl, now);
  const fullText = chapters.map((chapter) => chapter.text).join('\n\n');
  const fullSourceText = chapters.map((chapter) => chapter.sourceText || '').join('\n\n');
  const book = {
    id: String(now.getTime()),
    title,
    sourceUrl,
    coverUrl: coverUrl || '',
    images: coverUrl ? [coverUrl] : [],
    chapters,
    readingProgress: {
      chapterIndex: 0,
      percent: 0,
      bookmarked: false
    },
    sourceLength: fullSourceText.length,
    translatedLength: fullText.length,
    createdAt: now.toISOString(),
    text: fullText
  };

  books.unshift(book);
  writeBooks(books);
  return book;
}

function buildBookTitle(sourceUrl, date) {
  try {
    const parsed = new URL(sourceUrl);
    const parts = parsed.pathname.split('/').filter(Boolean);
    const lastPart = parts[parts.length - 1] || parsed.hostname;
    return decodeURIComponent(lastPart).replace(/[-_]+/g, ' ').trim() || `Bản dịch ${date.toLocaleString('vi-VN')}`;
  } catch {
    return `Bản dịch ${date.toLocaleString('vi-VN')}`;
  }
}

function splitIntoChapters(text) {
  const normalizedText = text.replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const paragraphs = normalizedText.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);

  const totalLength = normalizedText.length;
  const targetLength = Math.ceil(totalLength / 3);

  const chunks = [];
  let current = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    if (chunks.length < 2 && currentLength + paragraph.length > targetLength && current.length) {
      chunks.push(current.join('\n\n'));
      current = [];
      currentLength = 0;
    }
    current.push(paragraph);
    currentLength += paragraph.length + 2;
  }
  if (current.length) {
    chunks.push(current.join('\n\n'));
  }

  // Fallback in case we got fewer than 3 chunks
  while (chunks.length < 3 && chunks.length > 0) {
    // If we only have 1 or 2 chunks, we can just return what we have
    break;
  }

  return chunks.map((chunk, index) => ({
    id: `chapter-${index + 1}`,
    title: `Phần ${index + 1}`,
    sourceText: chunk
  }));
}

function normalizeChapterTitle(value) {
  return String(value || '')
    .replace(/^[\s•●\-\u2022]+/, '')
    .replace(/\s+/g, ' ')
    .replace(/[.。]+$/, '')
    .trim()
    .toLowerCase();
}

function extractTocTitles(lines) {
  const tocStart = lines.findIndex((line) => /table\s+of\s+contents|contents/i.test(line));
  if (tocStart === -1) return [];

  const titles = [];
  for (let index = tocStart + 1; index < Math.min(lines.length, tocStart + 60); index += 1) {
    const raw = lines[index].trim();
    const cleaned = raw.replace(/^[\s•●\-\u2022]+/, '').trim();
    if (!cleaned) {
      if (titles.length > 2) break;
      continue;
    }
    if (/^(chapter|page|\d+[\s/]\d+)$/i.test(cleaned)) continue;
    if (cleaned.length < 4 || cleaned.length > 110) continue;
    if (!/[A-Za-z]/.test(cleaned)) continue;
    titles.push(cleaned);
  }

  return Array.from(new Set(titles));
}

function removeTocBlock(lines) {
  const tocStart = lines.findIndex((line) => /table\s+of\s+contents|contents/i.test(line));
  if (tocStart === -1) return lines;

  let tocEnd = tocStart + 1;
  for (; tocEnd < Math.min(lines.length, tocStart + 70); tocEnd += 1) {
    const line = lines[tocEnd].trim();
    if (/^(chapter|prologue|epilogue)\b/i.test(line) && tocEnd > tocStart + 4) break;
  }

  return [...lines.slice(0, tocStart), ...lines.slice(tocEnd)];
}

function splitTextByTitles(text, titles) {
  const paragraphs = text.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const chapterCount = Math.max(1, titles.length);
  const targetLength = Math.ceil(text.length / chapterCount);
  const chapters = [];
  let current = [];
  let currentLength = 0;
  let titleIndex = 0;

  for (const paragraph of paragraphs) {
    if (titleIndex < chapterCount - 1 && current.length && currentLength + paragraph.length > targetLength) {
      chapters.push({
        id: `chapter-${chapters.length + 1}`,
        title: titles[titleIndex] || `Chapter ${chapters.length + 1}`,
        sourceText: current.join('\n\n')
      });
      titleIndex += 1;
      current = [];
      currentLength = 0;
    }

    current.push(paragraph);
    currentLength += paragraph.length + 2;
  }

  if (current.length) {
    chapters.push({
      id: `chapter-${chapters.length + 1}`,
      title: titles[titleIndex] || `Chapter ${chapters.length + 1}`,
      sourceText: current.join('\n\n')
    });
  }

  return chapters;
}

function splitChapterForTranslation(sourceText, maxLength = 25000) {
  const paragraphs = String(sourceText || '').split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
  const parts = [];
  let current = [];
  let currentLength = 0;

  for (const paragraph of paragraphs) {
    if (current.length && currentLength + paragraph.length > maxLength) {
      parts.push(current.join('\n\n'));
      current = [];
      currentLength = 0;
    }

    current.push(paragraph);
    currentLength += paragraph.length + 2;
  }

  if (current.length) parts.push(current.join('\n\n'));
  return parts.length ? parts : [sourceText];
}

function extractGoogleDriveIdFromLink(link) {
  const raw = String(link || '').trim();
  const match = raw.match(/\/d\/([a-zA-Z0-9_-]+)/) || raw.match(/[?&]id=([a-zA-Z0-9_-]+)/);
  return match ? match[1] : raw;
}

function splitPlainTextIntoChapters(text, chapterCount = 1) {
  const count = Math.max(1, Number(chapterCount) || 1);
  const cleaned = String(text || '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean);
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

function cleanGeminiResponse(text) {
  return String(text || '')
    .replace(/(^|\n)\s*(Gemini\s+đã\s+nói|Gemini\s+said)\s*[:：]?\s*/gim, '\n')
    .replace(/(^|\n)\s*(Bản\s+nháp|Draft)\s*\d*\s*(?=\n|$)/gim, '\n')
    .replace(/^(Sure|Dưới\s+đây\s+là\s+bản\s+dịch|Đây\s+là\s+bản\s+dịch|Bản\s+dịch\s+tiếng\s+Việt|Bản\s+dịch)\s*[:：]?\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

async function launchBrowser({ visible = false, useChromeProfile = false } = {}) {
  assertChromeExists();
  const automationArgs = [
    '--headless=new',
    '--disable-gpu',
    '--window-size=1440,1000',
    '--window-position=-32000,-32000'
  ];

  const visibleArgs = [
    '--start-maximized'
  ];

  const launchOptions = {
    executablePath: CHROME_PATH,
    headless: visible ? false : 'new',
    defaultViewport: visible ? null : { width: 1440, height: 1000 },
    args: [
      ...(visible ? visibleArgs : automationArgs),
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--no-first-run',
      '--no-default-browser-check',
      '--lang=vi-VN'
    ],
    protocolTimeout: 180000
  };

  if (useChromeProfile) {
    const profileInfo = getLatestChromeProfileInfo();
    if (profileInfo.profilePath && fs.existsSync(profileInfo.profilePath)) {
      launchOptions.userDataDir = CHROME_USER_DATA_DIR;
      launchOptions.args.push('--profile-directory=' + profileInfo.profileDir);
    } else {
      launchOptions.userDataDir = SESSION_DIR;
    }
  } else {
    launchOptions.userDataDir = SESSION_DIR;
  }

  return puppeteer.launch(launchOptions);
}

  async function waitForGoogleLogin(page) {
    const start = Date.now();
    const maxWait = 180000;
  
    while (Date.now() - start < maxWait) {
      try {
        const currentUrl = page.url();
        
        // Check if we're on a Google page
        if (currentUrl.includes('google.com')) {
          const isLoggedIn = await page.evaluate(() => {
            // Check for common logged-in indicators
            if (document.querySelector('[data-email]')) return true;
            if (document.querySelector('img[aria-label*="account"]')) return true;
            
            // Check for email in page elements
            const bodyText = document.body.innerText || '';
            if (bodyText.includes('@')) {
              const emailMatch = bodyText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
              if (emailMatch) return true;
            }
            
            // Check for profile menu or account button
            if (document.querySelector('button[aria-label*="Account"]')) return true;
            if (document.querySelector('[role="button"][aria-label*="Google Account"]')) return true;
            
            return false;
          }).catch(() => false);
  
          if (isLoggedIn) return true;
        }
      } catch (e) {
        console.error('Error checking Google login:', e.message);
      }
  
      await page.waitForTimeout(1500);
    }
  
    return false;
  }

  async function extractGoogleEmail(page) {
    try {
      const email = await page.evaluate(() => {
        const emailRegex = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/;
        
        // Check data attributes
        const dataEmailEl = document.querySelector('[data-email]');
        if (dataEmailEl) {
          const email = dataEmailEl.getAttribute('data-email');
          if (email && email.includes('@')) return email.toLowerCase();
        }
  
        // Check title or aria-label on images/buttons
        const elements = Array.from(document.querySelectorAll('[aria-label*="@"], [title*="@"]'));
        for (const el of elements) {
          const text = (el.getAttribute('aria-label') || el.getAttribute('title') || '').trim();
          const match = text.match(emailRegex);
          if (match) return match[0].toLowerCase();
        }
  
        // Search all text nodes
        const walker = document.createTreeWalker(
          document.body,
          NodeFilter.SHOW_TEXT,
          null,
          false
        );
        
        let node;
        while (node = walker.nextNode()) {
          const text = node.textContent.trim();
          if (text.length > 5 && text.length < 100) {
            const match = text.match(emailRegex);
            if (match) return match[0].toLowerCase();
          }
        }
  
        return '';
      }).catch(() => '');
  
      return email || '';
    } catch (e) {
      console.error('Error extracting Google email:', e.message);
      return '';
    }
  }

async function signInWithGoogle() {
  let browser;

  try {
    browser = await launchBrowser({ visible: true, useChromeProfile: true });
    const [page] = await browser.pages();
    const activePage = page || await browser.newPage();

    await activePage.goto('https://accounts.google.com/signin/v2/identifier?continue=https://myaccount.google.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    const signedIn = await waitForGoogleLogin(activePage);
    if (!signedIn) {
      throw new Error('Không xác nhận được đăng nhập Google trong thời gian chờ. Hãy thử lại.');
    }

    const email = await extractGoogleEmail(activePage);
    return { email: email || '' };
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }
}

// Use Chrome profile to sign in with Google by launching Chrome via Puppeteer
async function signInWithGooglePopup() {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 900,
      height: 600,
      resizable: false,
      backgroundColor: '#f0f4f9',
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false
      }
    });

    // Remove menu bar
    authWindow.setMenuBarVisibility(false);

    let finished = false;

    ipcMain.once('google-signin-success', (event, { email }) => {
      if (!finished) {
        finished = true;
        try { authWindow.close(); } catch {}
        resolve({ email });
      }
    });

    ipcMain.once('google-signin-cancel', () => {
      if (!finished) {
        finished = true;
        try { authWindow.close(); } catch {}
        reject(new Error('Đăng nhập bị huỷ.'));
      }
    });

    authWindow.on('closed', () => {
      if (!finished) {
        finished = true;
        reject(new Error('Cửa sổ đăng nhập bị đóng.'));
      }
      // Clean up listeners
      ipcMain.removeAllListeners('google-signin-success');
      ipcMain.removeAllListeners('google-signin-cancel');
    });

    authWindow.loadFile('google-auth.html').catch((err) => {
      if (!finished) {
        finished = true;
        reject(err);
      }
    });
  });
}

async function confirmFacebookLoginPopup() {
  return new Promise((resolve, reject) => {
    const authWindow = new BrowserWindow({
      width: 760,
      height: 820,
      title: 'Facebook Login',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true
      }
    });

    let finished = false;
    const timeout = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { authWindow.close(); } catch {}
        reject(new Error('Không xác nhận được đăng nhập Facebook trong thời gian chờ.'));
      }
    }, 180000);

    function complete() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      try { authWindow.close(); } catch {}
      resolve({ ok: true });
    }

    authWindow.on('closed', () => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(new Error('Cửa sổ đăng nhập Facebook bị đóng.'));
      }
    });

    authWindow.webContents.on('did-navigate', (_event, url) => {
      if (/facebook\.com\/(home|profile|friends|notifications|marketplace|watch|me)\b/i.test(url)) {
        complete();
      }
    });

    authWindow.webContents.on('did-finish-load', async () => {
      try {
        const bodyText = await authWindow.webContents.executeJavaScript('document.body ? document.body.innerText : ""');
        if (/What's on your mind|Bạn đang nghĩ gì|News Feed|Bảng feed/i.test(bodyText || '')) {
          complete();
        }
      } catch {
        // ignore load/evaluation timing issues
      }
    });

    authWindow.loadURL('https://www.facebook.com/login/').catch((error) => {
      if (!finished) {
        finished = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
  });
}

async function ensureRemoteUser(user) {
  const existing = await getUserByEmail(user.email);
  if (existing) return existing;
  return await createUser(user.email, null, user.provider || 'google');
}

async function scrapeNovelText(page, novelUrl) {
  sendProgress('Đang tải trang truyện...', 8);

  await page.goto(novelUrl, {
    waitUntil: 'networkidle2',
    timeout: 90000
  });

  await page.waitForSelector('body', { timeout: 30000 });
  sendProgress('Đang lấy thông tin cơ bản của sách...', 18);

  const info = await page.evaluate(() => {
    function toAbsoluteUrl(value) {
      if (!value) return '';
      try {
        return new URL(value, window.location.href).toString();
      } catch {
        return '';
      }
    }

    function imageSource(image) {
      return toAbsoluteUrl(
        image.currentSrc
        || image.src
        || image.getAttribute('data-src')
        || image.getAttribute('data-original')
        || image.getAttribute('data-lazy-src')
        || image.getAttribute('data-thumb')
      );
    }

    function getCoverUrl() {
      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content')
        || document.querySelector('meta[name="twitter:image"]')?.getAttribute('content');
      if (ogImage) return toAbsoluteUrl(ogImage);

      const imgs = Array.from(document.images);
      for (const img of imgs) {
        const src = imageSource(img);
        if (!src || src.startsWith('data:')) continue;
        if (/logo|icon|avatar|sprite|loading|blank|toolbar|button|share/i.test(src)) continue;

        const rect = img.getBoundingClientRect();
        const width = img.naturalWidth || rect.width;
        const height = img.naturalHeight || rect.height;
        if (width >= 100 && height >= 100) {
          return src;
        }
      }
      return '';
    }

    const titleText = (
      document.querySelector('h1')?.innerText
      || document.querySelector('[property="og:title"]')?.getAttribute('content')
      || document.title
      || ''
    ).replace(/\s*-\s*(FLIPHTML5|Webnovel).*$/i, '').trim();

    return {
      coverUrl: getCoverUrl(),
      title: titleText
    };
  });

  sendProgress('Đã lấy xong thông tin sách.', 30);
  return info;
}

async function autoScroll(page) {
  await page.evaluate(async () => {
    await new Promise((resolve) => {
      let totalHeight = 0;
      const distance = 700;
      const timer = setInterval(() => {
        const scrollHeight = document.body.scrollHeight;
        window.scrollBy(0, distance);
        totalHeight += distance;

        if (totalHeight >= scrollHeight - window.innerHeight) {
          clearInterval(timer);
          window.scrollTo(0, 0);
          resolve();
        }
      }, 220);
    });
  });
}

async function preloadFlipbookPages(page) {
  sendProgress('Đang tải thêm trang và hình minh họa...', 24);
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press('ArrowRight').catch(() => { });
    await new Promise((resolve) => setTimeout(resolve, 550));
  }
  await page.keyboard.press('Home').catch(() => { });
  await new Promise((resolve) => setTimeout(resolve, 800));
}

async function translateLinkByChapters(page, url, title, maxChapters, extraPrompt) {
  const translatedChapters = [];

  for (let i = 1; i <= maxChapters; i++) {
    const chapterTitle = `Chương ${i}`;
    const baseProgress = 36 + Math.floor(((i - 1) / maxChapters) * 54);
    sendProgress(`Đang mở Chat mới để dịch ${chapterTitle} (${i}/${maxChapters})...`, baseProgress);

    await page.goto(GEMINI_URL, {
      waitUntil: 'networkidle2',
      timeout: 90000
    });
    await page.waitForSelector('body', { timeout: 30000 });
    await ensureGeminiReady(page);

    const chapterUrl = url.endsWith('/') ? `${url}${i}` : `${url}/${i}`;

    const prompt = [
      `dựa trên link '${chapterUrl}' hãy dịch chương ${i} của truyện`,
      title ? `Tên truyện: ${title}` : '',
      extraPrompt ? `Ghi chú thêm: ${extraPrompt}` : '',
      'Yêu cầu văn phong mượt mà, văn học, ngập tràn cảm xúc.',
      'Giữ nguyên các đoạn ngắt dòng và hội thoại.',
      'Không tóm tắt, không giải thích, không thêm câu dẫn.',
      'Chỉ trả về đúng nội dung bản dịch tiếng Việt:'
    ].filter(Boolean).join('\n');

    await fillGeminiInput(page, prompt);
    await submitGeminiPrompt(page);
    await waitForGeminiToStart(page);
    await waitForGeminiToFinish(page, i - 1, maxChapters);

    const translation = cleanGeminiResponse(await extractLatestGeminiResponse(page));
    if (!translation || translation.length < 20) {
      throw new Error(`Gemini không trả về bản dịch hợp lệ cho ${chapterTitle}.`);
    }

    translatedChapters.push({
      id: `chapter-${i}`,
      title: chapterTitle,
      text: translation,
      sourceText: url
    });
  }

  return translatedChapters;
}

async function translateWithGemini(page, englishText) {
  sendProgress('Đang mở Gemini trong nền...', 38);

  await page.goto(GEMINI_URL, {
    waitUntil: 'networkidle2',
    timeout: 90000
  });

  await page.waitForSelector('body', { timeout: 30000 });
  await ensureGeminiReady(page);

  const prompt = [
    'Dịch chương Light Novel sau sang tiếng Việt. Yêu cầu văn phong mượt mà, văn học, ngập tràn cảm xúc. Giữ nguyên các đoạn ngắt dòng và hội thoại, không tóm tắt, không giải thích gì thêm. Chỉ trả về nội dung bài dịch:',
    '',
    englishText
  ].join('\n');

  sendProgress('Đang nhập yêu cầu dịch...', 48);
  await fillGeminiInput(page, prompt);

  sendProgress('Đang gửi yêu cầu cho Gemini...', 56);
  await submitGeminiPrompt(page);

  sendProgress('Gemini đang dịch...', 64);
  await waitForGeminiToStart(page);
  await waitForGeminiToFinish(page);

  sendProgress('Đang lấy bản dịch tiếng Việt...', 88);
  const translation = await extractLatestGeminiResponse(page);

  if (!translation || translation.length < 20) {
    throw new Error('Gemini đã chạy xong nhưng không tìm thấy bản dịch hợp lệ.');
  }

  return cleanGeminiResponse(translation);
}

async function ensureGeminiReady(page) {
  const inputSelector = 'div[contenteditable="true"]';

  const ready = await page.waitForSelector(inputSelector, {
    visible: true,
    timeout: 120000
  }).then(() => true).catch(() => false);

  if (!ready) {
    throw new Error('Gemini chưa sẵn sàng. Hãy bấm "Đăng nhập Gemini" trong app và đăng nhập Google một lần trước.');
  }

  // Dismiss any popups/overlays/cookie banners that might block the input
  await page.evaluate(() => {
    const dismissKeywords = ['dismiss', 'close', 'got it', 'ok', 'accept', 'đồng ý', 'đóng', 'bỏ qua', 'skip'];
    const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
    for (const btn of buttons) {
      const label = (btn.textContent || '').toLowerCase().trim();
      const ariaLabel = (btn.getAttribute('aria-label') || '').toLowerCase();
      if (dismissKeywords.some(kw => label.includes(kw) || ariaLabel.includes(kw))) {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          btn.click();
          break;
        }
      }
    }
  }).catch(() => { });

  await new Promise((resolve) => setTimeout(resolve, 500));
}

async function fillGeminiInput(page, text) {
  const maxRetries = 3;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    await page.evaluate(({ promptText }) => {
      const input = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
        .find((node) => node.offsetParent !== null);

      if (!input) throw new Error('Không tìm thấy ô nhập nội dung của Gemini.');

      input.focus();
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);

      document.execCommand('delete', false, null);
      document.execCommand('insertText', false, promptText);

      // Dispatch events to make sure the framework (Angular/React) updates its state
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'a' }));
    }, { promptText: text });

    const filled = await page.waitForFunction(() => {
      const input = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
        .find((node) => node.offsetParent !== null);
      return Boolean(input && input.innerText.trim().length > 20);
    }, { timeout: 10000 }).then(() => true).catch(() => false);

    if (filled) {
      // Wait a tiny bit for UI state to propagate
      await new Promise((resolve) => setTimeout(resolve, 800));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error('Không nhập được nội dung vào ô chat Gemini sau nhiều lần thử.');
}

function countGeminiResponses(page) {
  return page.evaluate(() => {
    const selectors = [
      'model-response',
      'message-content',
      '[data-response-index]',
      '.conversation-container > div'
    ];
    let max = 0;
    for (const sel of selectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > max) max = count;
    }
    return max;
  });
}

async function submitGeminiPrompt(page) {
  const responseCountBefore = await countGeminiResponses(page);

  const clicked = await page.evaluate(() => {
    function visible(element) {
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    }

    const buttons = Array.from(document.querySelectorAll('button, [role="button"]')).filter(visible);
    const sendButton = buttons.find((button) => {
      const label = [
        button.getAttribute('aria-label') || '',
        button.getAttribute('title') || '',
        button.getAttribute('data-tooltip') || '',
        button.innerText || '',
        button.textContent || ''
      ].join(' ').toLowerCase();

      const iconText = Array.from(button.querySelectorAll('mat-icon, .material-symbols-outlined, [fonticon], .icon, svg'))
        .map((node) => `${node.textContent || ''} ${node.getAttribute('fonticon') || ''} ${node.getAttribute('class') || ''}`)
        .join(' ')
        .toLowerCase();

      return label.includes('send')
        || label.includes('gửi')
        || label.includes('submit')
        || iconText.includes('send')
        || iconText.includes('arrow_upward')
        || iconText.includes('arrow-upward');
    });

    if (sendButton && !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true') {
      sendButton.click();
      return true;
    }

    return false;
  });

  if (!clicked) {
    await page.keyboard.down('Control');
    await page.keyboard.press('Enter');
    await page.keyboard.up('Control');
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // Wait for submission: either input clears, or a loading indicator appears, or response count increases
  const submitted = await page.waitForFunction((prevCount) => {
    const input = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
      .find((node) => node.offsetParent !== null);
    const inputCleared = !input || input.innerText.trim().length < 5;

    const bodyText = document.body.innerText.toLowerCase();
    const generating = bodyText.includes('stop generating')
      || bodyText.includes('dừng tạo');

    // Check if a new response element appeared
    const selectors = ['model-response', 'message-content', '[data-response-index]', '.conversation-container > div'];
    let maxCount = 0;
    for (const sel of selectors) {
      const count = document.querySelectorAll(sel).length;
      if (count > maxCount) maxCount = count;
    }
    const newResponse = maxCount > prevCount;

    // Check for loading/thinking indicators
    const hasLoader = document.querySelector('.loading, .thinking, [data-loading], .spinner, mat-progress-bar, mat-spinner, .progress-indicator') !== null;

    return inputCleared || generating || newResponse || hasLoader;
  }, { timeout: 45000 }, responseCountBefore).then(() => true).catch(() => false);

  if (!submitted) {
    throw new Error('Không gửi được prompt cho Gemini. UI Gemini có thể đã đổi nút gửi hoặc tài khoản chưa đăng nhập.');
  }

  // Small delay to let Gemini start processing
  await new Promise((resolve) => setTimeout(resolve, 1000));
}

async function waitForGeminiToStart(page) {
  const started = await page.waitForFunction(() => {
    const text = document.body.innerText.toLowerCase();
    const hasStopBtn = text.includes('stop generating')
      || text.includes('dừng tạo');

    const hasResponse = document.querySelectorAll(
      'model-response, .model-response-text, message-content, [data-response-index], .markdown, .response-container'
    ).length > 0;

    const hasLoader = document.querySelector(
      '.loading, .thinking, [data-loading], .spinner, mat-progress-bar, mat-spinner, .progress-indicator'
    ) !== null;

    return hasStopBtn || hasResponse || hasLoader;
  }, { timeout: 60000 }).then(() => true).catch(() => false);

  if (!started) {
    console.warn('waitForGeminiToStart: Gemini may not have started generating. Proceeding anyway...');
  }

  // Small delay to let the response begin rendering
  await new Promise((resolve) => setTimeout(resolve, 1500));
}

async function waitForGeminiToFinish(page, chapterIndex = 0, chapterTotal = 1) {
  const maxWaitMs = 5 * 60 * 1000; // 5 minutes max per chapter
  const startedAt = Date.now();
  let stableCount = 0;
  let lastResponse = '';
  let lastResponseLength = 0;
  let noChangeCount = 0;
  let emptyResponseTime = 0; // track how long we've had no response

  while (Date.now() - startedAt < maxWaitMs) {
    const elapsed = Date.now() - startedAt;
    const chapterShare = 54 / Math.max(1, chapterTotal);
    const predicted = Math.min(
      90,
      36 + Math.floor(chapterIndex * chapterShare) + Math.floor((elapsed / maxWaitMs) * chapterShare)
    );
    sendProgress(`Gemini đang dịch chapter ${chapterIndex + 1}/${chapterTotal}... dự đoán ${predicted}%`, predicted);

    const state = await page.evaluate(() => {
      const bodyText = document.body.innerText.toLowerCase();

      // Only check for the exact "stop generating" / "dừng tạo" phrases
      const stillGenerating = bodyText.includes('stop generating')
        || bodyText.includes('dừng tạo');

      // Check for loading indicators
      const hasLoader = document.querySelector(
        '.loading, .thinking, [data-loading], .spinner, mat-progress-bar, mat-spinner, .progress-indicator'
      ) !== null;

      // Find the latest response text using multiple selectors
      const responseSelectors = [
        'model-response .markdown',
        'model-response message-content',
        'model-response',
        'message-content',
        '.model-response-text',
        '.markdown.markdown-main-panel',
        '.markdown',
        '[data-response-index]',
        '.response-container'
      ];

      let latest = '';
      for (const selector of responseSelectors) {
        const nodes = Array.from(document.querySelectorAll(selector))
          .map((node) => node.innerText.trim())
          .filter((text) => text.length > 20);
        if (nodes.length) {
          latest = nodes[nodes.length - 1];
          break;
        }
      }

      // Check if the input is ready for a new prompt
      const input = Array.from(document.querySelectorAll('div[contenteditable="true"]'))
        .find((node) => node.offsetParent !== null);
      const inputReady = Boolean(input);

      // Check if any send button is now enabled (sign that generation is done)
      const sendBtnReady = Array.from(document.querySelectorAll('button, [role="button"]')).some((btn) => {
        const label = (btn.getAttribute('aria-label') || btn.textContent || '').toLowerCase();
        const isVisible = btn.getBoundingClientRect().width > 0;
        return isVisible && !btn.disabled && (label.includes('send') || label.includes('gửi'));
      });

      // Grab full page text for debugging if no response found
      const debugText = latest ? '' : bodyText.substring(0, 500);

      return {
        stillGenerating: stillGenerating || hasLoader,
        latest,
        latestLength: latest.length,
        inputReady,
        sendBtnReady,
        debugText
      };
    });

    // Track response stability
    if (state.latest && state.latest === lastResponse) {
      stableCount += 1;
    } else {
      stableCount = 0;
      lastResponse = state.latest || lastResponse;
    }

    // Track if response length is changing
    if (state.latestLength === lastResponseLength && state.latestLength > 0) {
      noChangeCount += 1;
    } else {
      noChangeCount = 0;
      lastResponseLength = state.latestLength;
    }

    // Track empty response duration
    if (!state.latest || state.latest.length < 30) {
      emptyResponseTime += 1500;
    } else {
      emptyResponseTime = 0;
    }

    // Done conditions:
    const hasContent = state.latest && state.latest.length > 30;

    // 1. Not generating + input ready + has response + stable for 3 checks (~4.5s)
    if (!state.stillGenerating && state.inputReady && hasContent && stableCount >= 3) return;
    // 2. Not generating + send button ready + has response + stable for 2 checks
    if (!state.stillGenerating && state.sendBtnReady && hasContent && stableCount >= 2) return;
    // 3. Response stable for 6 checks (~9s) regardless of other indicators (failsafe)
    if (hasContent && noChangeCount >= 6) {
      console.warn('waitForGeminiToFinish: Response stable for extended period, assuming complete.');
      return;
    }
    // 4. Not generating + has content (simplest check - if generation stopped and we have text)
    if (!state.stillGenerating && hasContent && stableCount >= 1) return;

    // 5. If no response found for 60+ seconds, log debug info
    if (emptyResponseTime >= 60000 && emptyResponseTime % 30000 < 1500) {
      console.warn('waitForGeminiToFinish: No response detected for', Math.round(emptyResponseTime / 1000), 's. Page text:', state.debugText);
      sendProgress(`Đang chờ Gemini phản hồi... (${Math.round(emptyResponseTime / 1000)}s)`, predicted);
    }

    // 6. If no response for 120 seconds, try to grab any text from the page as fallback
    if (emptyResponseTime >= 120000) {
      const fallbackText = await page.evaluate(() => {
        // Try to find ANY new text content on the page that looks like a translation
        const allText = document.body.innerText;
        const lines = allText.split('\n').filter(l => l.trim().length > 30);
        // Get text that contains Vietnamese characters (likely a translation)
        const vnLines = lines.filter(l => /[àáạảãèéẹẻẽòóọỏõùúụủũươđăâêô]/i.test(l));
        if (vnLines.length > 2) {
          return vnLines.slice(-20).join('\n');
        }
        return '';
      }).catch(() => '');

      if (fallbackText && fallbackText.length > 50) {
        console.warn('waitForGeminiToFinish: Using fallback text extraction.');
        lastResponse = fallbackText;
        return;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 1500));
  }

  // If we have any response at all after timeout, don't throw - use what we have
  if (lastResponse && lastResponse.length > 30) {
    console.warn('waitForGeminiToFinish: Timeout reached but response available. Proceeding with partial result.');
    return;
  }

  throw new Error('Quá thời gian chờ Gemini dịch xong. Hãy thử lại với chế độ Debug (hiển Chrome).');
}

async function extractLatestGeminiResponse(page) {
  return page.evaluate(() => {
    const selectors = [
      'model-response .markdown',
      'model-response message-content',
      'model-response',
      'message-content',
      '.model-response-text',
      '.markdown.markdown-main-panel',
      '.markdown',
      '[data-response-index] .markdown',
      '[data-response-index]',
      '.response-container .markdown',
      '.response-container',
      '.conversation-container .markdown'
    ];

    for (const selector of selectors) {
      const nodes = Array.from(document.querySelectorAll(selector))
        .map((node) => node.innerText.trim())
        .filter((text) => text.length > 20);

      if (nodes.length) {
        return nodes[nodes.length - 1]
          .replace(/(^|\n)\s*(Gemini\s+đã\s+nói|Gemini\s+said)\s*[:：]?\s*/gim, '\n')
          .replace(/(^|\n)\s*(Bản\s+nháp|Draft)\s*\d*\s*(?=\n|$)/gim, '\n')
          .replace(/\n{3,}/g, '\n\n')
          .trim();
      }
    }

    return '';
  });
}

function validateNovelUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
    if (!parsed.protocol.startsWith('http')) {
      throw new Error();
    }
  } catch {
    throw new Error('Vui lòng nhập một đường link (URL) hợp lệ (bắt đầu bằng http:// hoặc https://).');
  }

  return parsed.toString();
}

ipcMain.handle('setup-gemini-session', async (_event, currentEmail) => {
  let browser;

  try {
    requireAdminUser(currentEmail);
    sendProgress('Đang mở Chrome để đăng nhập Gemini...', 5);
    browser = await launchBrowser({ visible: true });
    const [page] = await browser.pages();
    const activePage = page || await browser.newPage();
    await activePage.goto(GEMINI_URL, { waitUntil: 'domcontentloaded', timeout: 90000 });
    sendProgress('Hãy đăng nhập Gemini trong cửa sổ Chrome vừa mở. Sau khi xong có thể đóng Chrome.', 100);
    return { ok: true };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendProgress(`Lỗi: ${message}`, 0);
    if (browser) await browser.close().catch(() => { });
    return { ok: false, error: message };
  }
});

ipcMain.handle('run-automation', async (_event, rawUrl, options = {}, currentEmail) => {
  let browser;
  const debugMode = options && options.debug === true;
  const maxChapters = parseInt(options.maxChapters, 10) || 10;
  const customTitle = options.customTitle || '';
  const customCover = options.customCover || '';

  try {
    const novelUrl = validateNovelUrl(rawUrl);
    if (debugMode) {
      sendProgress('Chế độ Debug: Mở Chrome hiển thị để theo dõi...', 3);
    }
    browser = await launchBrowser({ visible: debugMode });

    const [page] = await browser.pages();
    const activePage = page || await browser.newPage();
    activePage.setDefaultTimeout(90000);
    activePage.setDefaultNavigationTimeout(120000);

    const info = await scrapeNovelText(activePage, novelUrl);
    const finalTitle = customTitle || info.title || 'Unknown Novel';
    const finalCoverUrl = customCover || info.coverUrl || '';
    const extraPrompt = options.extraPrompt || '';

    const translatedChapters = await translateLinkByChapters(activePage, novelUrl, finalTitle, maxChapters, extraPrompt);
    const book = saveBook({
      sourceUrl: novelUrl,
      chapters: translatedChapters,
      coverUrl: finalCoverUrl,
      title: finalTitle
    });

    sendProgress('Hoàn tất. Đã lưu sách vào thư viện.', 100);

    return {
      ok: true,
      book,
      books: readBooks().map(publicBookMeta)
    };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    sendProgress(`Lỗi: ${message}`, 0);
    return { ok: false, error: message };
  } finally {
    if (browser) {
      await browser.close().catch(() => { });
    }
  }
});

ipcMain.handle('list-books', async () => {
  return readBooks().map(publicBookMeta);
});

ipcMain.handle('get-book', async (_event, id) => {
  const book = readBooks().find((item) => item.id === id);
  return book ? normalizeBook(book) : null;
});

ipcMain.handle('delete-book', async (_event, id) => {
  const books = readBooks();
  const nextBooks = books.filter((item) => item.id !== id);
  writeBooks(nextBooks);
  return nextBooks.map(publicBookMeta);
});

ipcMain.handle('save-reading-progress', async (_event, payload) => {
  const books = readBooks();
  const bookIndex = books.findIndex((item) => item.id === payload.id);

  if (bookIndex === -1) return null;

  const book = normalizeBook(books[bookIndex]);
  book.readingProgress = {
    chapterIndex: Math.max(0, Number(payload.chapterIndex) || 0),
    percent: Math.max(0, Math.min(100, Number(payload.percent) || 0)),
    bookmarked: Boolean(payload.bookmarked)
  };

  books[bookIndex] = book;
  writeBooks(books);
  return publicBookMeta(book);
});

ipcMain.handle('upload-file', async (_event, { fileName, fileData, title, chapterCount, coverData, coverFileName, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    
    if (!fileName || !fileData) {
      throw new Error('File name hoặc file data bị thiếu.');
    }

    const ext = path.extname(fileName).toLowerCase();
    if (!['.pdf', '.docx', '.doc'].includes(ext)) {
      throw new Error('Chỉ hỗ trợ file PDF (.pdf), Word (.docx, .doc).');
    }

    // Ensure FILES_DIR exists
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }

    const fileId = crypto.randomBytes(6).toString('hex');
    const uniqueFileName = `${fileId}${ext}`;
    const destPath = path.join(FILES_DIR, uniqueFileName);

    // Convert fileData to Buffer if it's a Uint8Array
    const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);
    fs.writeFileSync(destPath, buffer);

    // Handle cover image if provided
    let coverUrl = null;
    let coverPath = null;
    if (coverData && coverFileName) {
      const coverExt = path.extname(coverFileName).toLowerCase();
      const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (validImageExts.includes(coverExt)) {
        const coverId = `cover_${fileId}`;
        const uniqueCoverName = `${coverId}${coverExt}`;
        coverPath = path.join(FILES_DIR, uniqueCoverName);
        const coverBuffer = Buffer.isBuffer(coverData) ? coverData : Buffer.from(coverData);
        fs.writeFileSync(coverPath, coverBuffer);
        // Create file:// URL for local file access in Electron
        coverUrl = `file://${coverPath.replace(/\\/g, '/')}`;
      }
    }

    const fileRecord = {
      id: fileId,
      title: title || fileName.replace(/\.[^/.]+$/, ''),
      fileType: ext === '.pdf' ? 'pdf' : 'word',
      fileName: uniqueFileName,
      filePath: destPath,
      chapterCount: chapterCount || 1,
      coverUrl: coverUrl,
      uploadedAt: new Date().toISOString(),
      uploadedBy: currentEmail,
      size: fs.statSync(destPath).size
    };

    const files = readFilesIndex();
    files.push(fileRecord);
    writeFilesIndex(files);

    return { ok: true, file: fileRecord };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('list-files', async () => {
  try {
    const files = readFilesIndex();
    return { ok: true, files };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

// Helper to download from URL
function downloadFromUrl(urlStr) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr);
    const protocol = url.protocol === 'https:' ? https : require('http');
    
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    };

    const req = protocol.request(options, (res) => {
      // Handle redirects
      if (res.statusCode === 301 || res.statusCode === 302 || res.statusCode === 303 || res.statusCode === 307) {
        return downloadFromUrl(res.headers.location).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }

      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve(Buffer.concat(chunks));
      });
    });

    req.on('error', reject);
    req.end();
  });
}

ipcMain.handle('upload-from-google-docs', async (_event, { docId, title, chapterCount, coverData, coverFileName, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);

    // Ensure FILES_DIR exists
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }

    // Download Google Doc as PDF
    const googleDocsUrl = `https://docs.google.com/document/d/${docId}/export?format=pdf`;
    const fileBuffer = await downloadFromUrl(googleDocsUrl);

    const fileId = crypto.randomBytes(6).toString('hex');
    const uniqueFileName = `${fileId}.pdf`;
    const destPath = path.join(FILES_DIR, uniqueFileName);

    fs.writeFileSync(destPath, fileBuffer);

    // Handle cover image if provided
    let coverUrl = null;
    if (coverData && coverFileName) {
      const coverExt = path.extname(coverFileName).toLowerCase();
      const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (validImageExts.includes(coverExt)) {
        const coverId = `cover_${fileId}`;
        const uniqueCoverName = `${coverId}${coverExt}`;
        const coverPath = path.join(FILES_DIR, uniqueCoverName);
        const coverBuffer = Buffer.isBuffer(coverData) ? coverData : Buffer.from(coverData);
        fs.writeFileSync(coverPath, coverBuffer);
        coverUrl = `file://${coverPath.replace(/\\/g, '/')}`;
      }
    }

    const fileRecord = {
      id: fileId,
      title: title,
      fileType: 'pdf',
      fileName: uniqueFileName,
      filePath: destPath,
      chapterCount: chapterCount || 1,
      coverUrl: coverUrl,
      uploadedAt: new Date().toISOString(),
      uploadedBy: currentEmail,
      size: fs.statSync(destPath).size
    };

    const files = readFilesIndex();
    files.push(fileRecord);
    writeFilesIndex(files);

    return { ok: true, file: fileRecord };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('upload-from-google-drive', async (_event, { driveId, title, chapterCount, coverData, coverFileName, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);

    // Ensure FILES_DIR exists
    if (!fs.existsSync(FILES_DIR)) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
    }

    // Download from Google Drive
    const googleDriveUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
    const fileBuffer = await downloadFromUrl(googleDriveUrl);

    // Try to determine file type from the downloaded content
    let fileType = 'file';
    let fileExt = '.bin';
    
    // PDF signature
    if (fileBuffer[0] === 0x25 && fileBuffer[1] === 0x50 && fileBuffer[2] === 0x44) {
      fileType = 'pdf';
      fileExt = '.pdf';
    }
    // DOCX/XLSX signature (ZIP)
    else if (fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B && fileBuffer[2] === 0x03) {
      fileType = 'word';
      fileExt = '.docx';
    }

    const fileId = crypto.randomBytes(6).toString('hex');
    const uniqueFileName = `${fileId}${fileExt}`;
    const destPath = path.join(FILES_DIR, uniqueFileName);

    fs.writeFileSync(destPath, fileBuffer);

    // Handle cover image if provided
    let coverUrl = null;
    if (coverData && coverFileName) {
      const coverExt = path.extname(coverFileName).toLowerCase();
      const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (validImageExts.includes(coverExt)) {
        const coverId = `cover_${fileId}`;
        const uniqueCoverName = `${coverId}${coverExt}`;
        const coverPath = path.join(FILES_DIR, uniqueCoverName);
        const coverBuffer = Buffer.isBuffer(coverData) ? coverData : Buffer.from(coverData);
        fs.writeFileSync(coverPath, coverBuffer);
        coverUrl = `file://${coverPath.replace(/\\/g, '/')}`;
      }
    }

    const fileRecord = {
      id: fileId,
      title: title,
      fileType: fileType,
      fileName: uniqueFileName,
      filePath: destPath,
      chapterCount: chapterCount || 1,
      coverUrl: coverUrl,
      uploadedAt: new Date().toISOString(),
      uploadedBy: currentEmail,
      size: fs.statSync(destPath).size
    };

    const files = readFilesIndex();
    files.push(fileRecord);
    writeFilesIndex(files);

    return { ok: true, file: fileRecord };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('push-google-drive-pdf-book', async (_event, { driveLink, title, chapterCount, coverData, coverFileName, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);

    const driveId = extractGoogleDriveIdFromLink(driveLink);
    if (!driveId) throw new Error('Link Google Drive khong hop le.');
    const bookTitle = String(title || '').trim();
    if (!bookTitle) throw new Error('Vui long nhap ten truyen.');

    const googleDriveUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
    const fileBuffer = await downloadFromUrl(googleDriveUrl);
    const looksLikePdf = fileBuffer.length > 5 && fileBuffer.slice(0, 5).toString('utf8') === '%PDF-';
    if (!looksLikePdf) {
      throw new Error('Khong tai duoc file PDF. Hay dam bao link Google Drive la file PDF va da bat chia se Anyone with the link.');
    }

    let coverUrl = '';
    if (coverData && coverFileName) {
      fs.mkdirSync(FILES_DIR, { recursive: true });
      const coverExt = path.extname(coverFileName).toLowerCase();
      const validImageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
      if (validImageExts.includes(coverExt)) {
        const coverPath = path.join(FILES_DIR, `drive_cover_${Date.now()}${coverExt}`);
        const coverBuffer = Buffer.isBuffer(coverData) ? coverData : Buffer.from(coverData);
        fs.writeFileSync(coverPath, coverBuffer);
        coverUrl = `file://${coverPath.replace(/\\/g, '/')}`;
      }
    }

    const pdfResult = await pdfParse(fileBuffer);
    const extractedText = String(pdfResult?.text || '').replace(/\r\n/g, '\n').trim();
    if (!extractedText || extractedText.length < 50) {
      throw new Error('PDF nay khong co text de trich xuat. Neu PDF la anh scan, can OCR truoc.');
    }

    const chapters = splitPlainTextIntoChapters(extractedText, chapterCount);
    if (!chapters.length) throw new Error('Khong chia duoc noi dung PDF thanh chuong.');

    const book = normalizeBook(saveBook({
      sourceUrl: `https://drive.google.com/file/d/${driveId}/view`,
      chapters,
      coverUrl,
      extractedTitle: bookTitle
    }));

    const baseUrl = getFirebaseDatabaseUrl();
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' }) || {};
    const remoteBooks = Array.isArray(data?.books) ? data.books : [];
    const existingIndex = remoteBooks.findIndex((item) => item.id === book.id);
    if (existingIndex >= 0) remoteBooks[existingIndex] = book;
    else remoteBooks.unshift(book);

    const updatedAt = new Date().toISOString();
    await firebaseRequest(baseUrl, 'novelReader', {
      method: 'PUT',
      body: JSON.stringify({ ...data, updatedAt, books: remoteBooks })
    });

    return {
      ok: true,
      book: publicBookMeta(book),
      books: readBooks().map(publicBookMeta),
      chapterCount: chapters.length,
      textLength: extractedText.length
    };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('delete-file', async (_event, fileId, currentEmail) => {
  try {
    await requireAdminUser(currentEmail);
    const files = readFilesIndex();
    const fileRecord = files.find(f => f.id === fileId);
    
    if (!fileRecord) {
      throw new Error('File không tìm thấy.');
    }

    if (fs.existsSync(fileRecord.filePath)) {
      fs.unlinkSync(fileRecord.filePath);
    }

    const nextFiles = files.filter(f => f.id !== fileId);
    writeFilesIndex(nextFiles);

    return { ok: true, count: nextFiles.length };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('download-file', async (_event, fileId, currentEmail) => {
  try {
    if (!currentEmail) {
      throw new Error('Bạn cần đăng nhập để tải file.');
    }
    const files = readFilesIndex();
    const fileRecord = files.find(f => f.id === fileId);
    
    if (!fileRecord || !fs.existsSync(fileRecord.filePath)) {
      throw new Error('File không tồn tại.');
    }

    const buffer = fs.readFileSync(fileRecord.filePath);
    return { ok: true, data: buffer.toString('base64'), fileName: fileRecord.fileName, originalName: fileRecord.title };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('save-file-to-library', async (_event, fileId, currentEmail) => {
  try {
    if (!currentEmail) throw new Error('Bạn cần đăng nhập để lưu file vào thư viện.');

    const files = readFilesIndex();
    const fileRecord = files.find(f => f.id === fileId);
    if (!fileRecord || !fs.existsSync(fileRecord.filePath)) {
      throw new Error('File không tồn tại.');
    }

    // Ensure library dir
    const LIB_DIR = path.join(app.getPath('userData'), 'library_files');
    if (!fs.existsSync(LIB_DIR)) fs.mkdirSync(LIB_DIR, { recursive: true });

    const ext = path.extname(fileRecord.fileName) || '.' + (fileRecord.fileType || 'bin');
    const newFileName = `${fileRecord.id}${ext}`;
    const destPath = path.join(LIB_DIR, newFileName);
    fs.copyFileSync(fileRecord.filePath, destPath);

    // Copy cover if exists
    let coverUrl = fileRecord.coverUrl || '';
    if (fileRecord.coverUrl && fileRecord.coverUrl.startsWith('file://')) {
      // leave as is (local file URL)
    }

    // Try to extract readable text/html from known file types
    let extractedText = '';
    let isHtml = false;
    try {
      const lowerExt = ext.toLowerCase();
      if (lowerExt === '.pdf') {
        const dataBuffer = fs.readFileSync(destPath);
        try {
          const pdfResult = await pdfParse(dataBuffer);
          extractedText = (pdfResult && pdfResult.text) ? String(pdfResult.text).trim() : '';
        } catch (e) {
          extractedText = '';
        }
      } else if (lowerExt === '.docx') {
        try {
          const result = await mammoth.convertToHtml({ path: destPath });
          extractedText = result && result.value ? String(result.value) : '';
          isHtml = true;
        } catch (e) {
          extractedText = '';
          isHtml = false;
        }
      } else {
        extractedText = '';
      }
    } catch (convErr) {
      extractedText = '';
    }

    // Create a minimal book record pointing to the saved file
    const now = new Date();
    const book = {
      id: String(now.getTime()),
      title: fileRecord.title || fileRecord.fileName,
      sourceUrl: '',
      coverUrl: coverUrl || '',
      images: coverUrl ? [coverUrl] : [],
      chapters: [
        {
          id: 'file-1',
          title: fileRecord.title || 'File',
          text: extractedText || '',
          isHtml: isHtml,
          filePath: destPath,
          fileType: fileRecord.fileType || 'file'
        }
      ],
      readingProgress: { chapterIndex: 0, percent: 0, bookmarked: false },
      sourceLength: 0,
      translatedLength: 0,
      createdAt: now.toISOString(),
      text: extractedText || ''
    };

    const books = readBooks();
    books.unshift(book);
    writeBooks(books);

    return { ok: true, book };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

function normalizeFirebaseUrl(rawUrl) {
  let parsed;

  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error('Link Firebase Realtime Database không hợp lệ.');
  }

  if (!/^https:\/\/.+\.(firebaseio\.com|firebasedatabase\.app)$/i.test(parsed.origin)) {
    throw new Error('Link phải là Firebase Realtime Database URL, ví dụ https://your-db.firebaseio.com/');
  }

  return parsed.origin.replace(/\/$/, '');
}

async function firebaseRequest(baseUrl, pathName, options = {}) {
  const url = `${baseUrl}/${pathName.replace(/^\/+/, '')}.json`;
  const method = options.method || 'GET';
  const body = options.body || '';
  const headers = {
    'content-type': 'application/json'
  };

  if (body) {
    headers['content-length'] = Buffer.byteLength(body);
  }

  return new Promise((resolve, reject) => {
    const request = https.request(url, {
      method,
      headers,
      timeout: 30000
    }, (response) => {
      let responseBody = '';

      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        responseBody += chunk;
      });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`Firebase lỗi ${response.statusCode}: ${responseBody || response.statusMessage}`));
          return;
        }

        if (!responseBody) {
          resolve(null);
          return;
        }

        try {
          resolve(JSON.parse(responseBody));
        } catch {
          reject(new Error(`Firebase trả về dữ liệu không phải JSON: ${responseBody.slice(0, 200)}`));
        }
      });
    });

    request.on('timeout', () => {
      request.destroy(new Error('Kết nối Firebase quá thời gian chờ. Kiểm tra mạng hoặc URL database.'));
    });

    request.on('error', (error) => {
      reject(new Error(`Không kết nối được Firebase: ${error.code || error.message}`));
    });

    if (body) request.write(body);
    request.end();
  });
}

ipcMain.handle('auth-local-signup', async (_event, credentialsOrEmail, password) => {
  try {
    let email = credentialsOrEmail;
    let pwd = password;
    
    // Handle both object and separate parameter formats
    if (typeof credentialsOrEmail === 'object' && credentialsOrEmail !== null) {
      email = credentialsOrEmail.email;
      pwd = credentialsOrEmail.password;
    }
    
    if (!email || !pwd) {
      throw new Error('Email và mật khẩu là bắt buộc.');
    }
    
    const user = await createUser(email, pwd, 'local');
    setImmediate(() => autoSyncAllData());
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-local-signin', async (_event, credentialsOrEmail, password) => {
  try {
    let email = credentialsOrEmail;
    let pwd = password;
    
    // Handle both object and separate parameter formats
    if (typeof credentialsOrEmail === 'object' && credentialsOrEmail !== null) {
      email = credentialsOrEmail.email;
      pwd = credentialsOrEmail.password;
    }
    
    if (!email || !pwd) {
      throw new Error('Email và mật khẩu là bắt buộc.');
    }
    
    const normalizedEmail = String(email).trim().toLowerCase();
    const user = await getUserByEmail(normalizedEmail);
    if (!user) {
      return { ok: false, error: 'Email hoặc mật khẩu không đúng.' };
    }
    if (user.provider !== 'local') {
      return {
        ok: false,
        error: user.provider === 'google'
          ? 'Tài khoản này dùng Google để đăng nhập. Vui lòng chọn Google Sign-In.'
          : 'Tài khoản này không hỗ trợ mật khẩu cục bộ.'
      };
    }

    const passwordHash = hashPassword(pwd, user.salt || '');
    if (passwordHash !== user.passwordHash) {
      return { ok: false, error: 'Email hoặc mật khẩu không đúng.' };
    }

    const signedUser = publicUserRecord(user);

    setImmediate(() => autoSyncAllData());
    return { ok: true, user: signedUser };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-reset-password', async (_event, payload, maybePassword) => {
  try {
    const email = typeof payload === 'object' && payload !== null
      ? payload.email
      : payload;
    const password = typeof payload === 'object' && payload !== null
      ? (payload.password || payload.newPassword)
      : maybePassword;

    const user = await resetLocalPassword(email, password);
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-update-profile', async (_event, payload = {}) => {
  try {
    const user = await updateUserProfile(payload.email, payload.profile || payload);
    setImmediate(() => autoSyncAllData());
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-chrome-profile-info', async () => {
  try {
    const profileInfo = getLatestChromeProfileInfo();
    return {
      ok: true,
      chromePath: CHROME_PATH,
      profileDir: profileInfo.profileDir,
      profilePath: profileInfo.profilePath,
      source: profileInfo.source,
      exists: Boolean(profileInfo.profilePath && fs.existsSync(profileInfo.profilePath))
    };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-google-signin', async () => {
  try {
    const googleUser = await signInWithGooglePopup();
    if (!googleUser.email || !isValidEmail(googleUser.email)) {
      throw new Error('Không lấy được email Google hợp lệ. Hãy đăng nhập vào tài khoản Google chính chủ.');
    }
    const user = await ensureRemoteUser({ email: googleUser.email, provider: 'google' });
    setImmediate(() => autoSyncAllData());
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-facebook-signin', async (_event, payload = {}) => {
  try {
    const email = String(payload.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      throw new Error('Hãy nhập email Facebook hợp lệ để liên kết tài khoản.');
    }

    await confirmFacebookLoginPopup();
    const existing = await getUserByEmail(email);
    if (existing && existing.provider !== 'facebook') {
      throw new Error('Email này đã thuộc tài khoản khác. Hãy đăng nhập bằng phương thức đã dùng trước đó.');
    }

    const user = await ensureRemoteUser({
      email,
      provider: 'facebook'
    });

    if (payload.displayName || payload.avatarUrl) {
      const updated = await updateUserProfile(email, {
        displayName: payload.displayName || user.displayName || '',
        avatarUrl: payload.avatarUrl || user.avatarUrl || '',
        phone: user.phone || '',
        bio: user.bio || '',
        favoriteGenre: user.favoriteGenre || ''
      });
      setImmediate(() => autoSyncAllData());
      return { ok: true, user: updated };
    }

    setImmediate(() => autoSyncAllData());
    return { ok: true, user };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

ipcMain.handle('auth-signout', async () => {
  return { ok: true };
});

ipcMain.handle('auth-get-user', async (_event, email) => {
  const user = await getUserRecordByEmail(email);
  if (!user) {
    return { ok: false, error: 'User not found.' };
  }
  return { ok: true, user };
});

ipcMain.handle('auth-admin-list-users', async (_event, currentEmail) => {
  const currentUser = await getUserByEmail(currentEmail);
  if (!currentUser || currentUser.role !== 'admin') {
    return { ok: false, error: 'Permission denied. Only admin can view users.' };
  }
  const users = (await readUsers())
    .filter((user) => isValidEmail(user.email))
    .map(publicUserRecord);
  return { ok: true, users };
});

ipcMain.handle('auth-admin-delete-user', async (_event, targetEmail, currentEmail) => {
  const currentUser = await getUserByEmail(currentEmail);
  if (!currentUser || currentUser.role !== 'admin') {
    return { ok: false, error: 'Permission denied. Only admin can delete users.' };
  }
  const normalizedTarget = String(targetEmail || '').trim().toLowerCase();
  if (!normalizedTarget) {
    return { ok: false, error: 'Target email is required.' };
  }
  if (normalizedTarget === 'admin') {
    return { ok: false, error: 'Cannot delete the admin account.' };
  }
  await deleteUserByEmail(normalizedTarget);
  return { ok: true };
});

ipcMain.handle('auth-clear-users', async (_event, currentEmail) => {
  const currentUser = await getUserByEmail(currentEmail);
  if (!currentUser || currentUser.role !== 'admin') {
    return { ok: false, error: 'Permission denied. Only admin can clear users.' };
  }
  await clearUsers({ preserveAdmin: true });
  return { ok: true };
});

ipcMain.handle('get-firebase-config', async () => {
  return {
    databaseUrl: DEFAULT_FIREBASE_DATABASE_URL,
    ...readFirebaseConfig()
  };
});

ipcMain.handle('sync-to-firebase', async (_event, rawUrl, currentEmail) => {
  try {
    await requireAdminUser(currentEmail);
    const baseUrl = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
    const books = readBooks().map(normalizeBook);
    const users = (await readUsers()).map(publicUserRecord);
    const payload = {
      updatedAt: new Date().toISOString(),
      books,
      users
    };

    await firebaseRequest(baseUrl, 'novelReader', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    writeFirebaseConfig({ databaseUrl: baseUrl, lastSyncAt: payload.updatedAt });

    return {
      ok: true,
      count: books.length,
      updatedAt: payload.updatedAt
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
});

ipcMain.handle('pull-from-firebase', async (_event, rawUrl, currentEmail) => {
  try {
    if (!currentEmail) {
      throw new Error('Bạn cần đăng nhập để kéo truyện từ Firebase.');
    }
    const baseUrl = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' });
    const remoteBooks = Array.isArray(data?.books) ? data.books.map(normalizeBook) : [];
    const remoteUsers = data?.users || {};

    const mergedUsers = await mergeRemoteUsers(remoteUsers);
    writeBooks(remoteBooks);
    await writeUsers(mergedUsers);
    writeFirebaseConfig({ databaseUrl: baseUrl, lastPullAt: new Date().toISOString() });

    return {
      ok: true,
      count: remoteBooks.length,
      books: remoteBooks.map(publicBookMeta)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
});

// Load catalog (books available on Firebase) - for Discover display
ipcMain.handle('load-catalog', async (_event, rawUrl) => {
  try {
    const baseUrl = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' });
    const catalogBooks = Array.isArray(data?.books) ? data.books.map(normalizeBook) : [];

    return {
      ok: true,
      books: catalogBooks.map(book => ({
        id: book.id,
        title: book.title || 'Truyện không tên',
        coverUrl: book.coverUrl || '',
        chapterCount: (book.chapters || []).length,
        sourceUrl: book.sourceUrl || '',
        description: book.description || ''
      }))
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
});

// Pull a single book from Firebase to local library
ipcMain.handle('pull-single-book', async (_event, rawUrl, bookId, currentEmail) => {
  try {
    if (!currentEmail) {
      throw new Error('Bạn cần đăng nhập để tải truyện.');
    }
    if (!bookId) {
      throw new Error('ID truyện không hợp lệ.');
    }

    const baseUrl = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' });
    const remoteBooks = Array.isArray(data?.books) ? data.books : [];

    // Find the specific book
    const remoteBook = remoteBooks.find(b => b.id === bookId);
    if (!remoteBook) {
      throw new Error('Không tìm thấy truyện này trên Firebase.');
    }

    // Add/merge this book to local library
    const normalizedBook = normalizeBook(remoteBook);
    const localBooks = readBooks();
    const existingIndex = localBooks.findIndex(b => b.id === bookId);

    if (existingIndex >= 0) {
      localBooks[existingIndex] = normalizedBook;
    } else {
      localBooks.push(normalizedBook);
    }

    writeBooks(localBooks);
    writeFirebaseConfig({ databaseUrl: baseUrl, lastPullAt: new Date().toISOString() });

    return {
      ok: true,
      book: publicBookMeta(normalizedBook)
    };
  } catch (error) {
    return {
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  }
});

// Admin: delete a remote book from Firebase (admin-only)
ipcMain.handle('admin-delete-remote-book', async (_event, rawUrl, bookId, currentEmail) => {
  try {
    await requireAdminUser(currentEmail);
    if (!bookId) throw new Error('ID truyện không hợp lệ.');

    const baseUrl = normalizeFirebaseUrl(rawUrl || DEFAULT_FIREBASE_DATABASE_URL);
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' });
    const remoteBooks = Array.isArray(data?.books) ? data.books : [];

    const nextBooks = remoteBooks.filter((b) => b.id !== bookId);

    // Write back updated payload
    const payload = {
      updatedAt: new Date().toISOString(),
      books: nextBooks,
      users: data?.users || {}
    };

    await firebaseRequest(baseUrl, 'novelReader', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });

    writeFirebaseConfig({ databaseUrl: baseUrl, lastSyncAt: payload.updatedAt });

    return { ok: true, count: nextBooks.length };
  } catch (error) {
    return { ok: false, error: error && error.message ? error.message : String(error) };
  }
});

// --- Creator Space Feature ---
const CREATOR_BOOKS_FILE = path.join(app.getPath('userData'), 'creator_books.json');
const CREATOR_CHAPTERS_FILE = path.join(app.getPath('userData'), 'creator_chapters.json');
const CREATOR_FILES_DIR = path.join(app.getPath('userData'), 'creator_files');

function readCreatorBooks() {
  try {
    if (!fs.existsSync(CREATOR_BOOKS_FILE)) return [];
    const raw = fs.readFileSync(CREATOR_BOOKS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function writeCreatorBooks(books) {
  fs.mkdirSync(path.dirname(CREATOR_BOOKS_FILE), { recursive: true });
  fs.writeFileSync(CREATOR_BOOKS_FILE, JSON.stringify(books, null, 2), 'utf8');
}

function readCreatorChapters() {
  try {
    if (!fs.existsSync(CREATOR_CHAPTERS_FILE)) return [];
    const raw = fs.readFileSync(CREATOR_CHAPTERS_FILE, 'utf8');
    return JSON.parse(raw) || [];
  } catch {
    return [];
  }
}

function writeCreatorChapters(chapters) {
  fs.mkdirSync(path.dirname(CREATOR_CHAPTERS_FILE), { recursive: true });
  fs.writeFileSync(CREATOR_CHAPTERS_FILE, JSON.stringify(chapters, null, 2), 'utf8');
}

function saveCreatorUploadedFile(fileData, fileName) {
  if (!fileData || !fileName) return '';
  fs.mkdirSync(CREATOR_FILES_DIR, { recursive: true });
  const fileId = crypto.randomBytes(6).toString('hex');
  const ext = path.extname(fileName).toLowerCase();
  const uniqueName = `${fileId}${ext}`;
  const destPath = path.join(CREATOR_FILES_DIR, uniqueName);
  const buffer = Buffer.isBuffer(fileData) ? fileData : Buffer.from(fileData);
  fs.writeFileSync(destPath, buffer);
  return `file://${destPath.replace(/\\/g, '/')}`;
}

async function extractTextFromFile(filePath) {
  try {
    const cleanPath = filePath.replace(/^file:\/\//, '');
    if (!fs.existsSync(cleanPath)) return `[Không tìm thấy file: ${cleanPath}]`;
    const ext = path.extname(cleanPath).toLowerCase();
    
    if (ext === '.txt') {
      return fs.readFileSync(cleanPath, 'utf8');
    } else if (ext === '.docx') {
      const res = await mammoth.convertToHtml({ path: cleanPath });
      return res && res.value ? String(res.value) : '';
    } else if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(cleanPath);
      const pdfResult = await pdfParse(dataBuffer);
      return pdfResult && pdfResult.text ? String(pdfResult.text).trim() : '';
    }
    return `[File định dạng không hỗ trợ: ${ext}]`;
  } catch (error) {
    return `[Lỗi đọc file: ${error.message}]`;
  }
}

ipcMain.handle('creator-list-books', async () => {
  try {
    return { ok: true, books: readCreatorBooks() };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-create-book', async (_event, { title, coverUrl, coverFileName, coverData, description, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    if (!title) throw new Error('Tiêu đề truyện không được để trống.');
    
    let finalCoverUrl = coverUrl || '';
    if (coverData && coverFileName) {
      finalCoverUrl = saveCreatorUploadedFile(coverData, coverFileName);
    }

    const books = readCreatorBooks();
    const newBook = {
      id: `book_${Date.now()}`,
      title,
      coverUrl: finalCoverUrl,
      description: description || '',
      createdAt: new Date().toISOString()
    };

    books.push(newBook);
    writeCreatorBooks(books);
    return { ok: true, book: newBook };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-list-chapters', async (_event, { bookId }) => {
  try {
    const chapters = readCreatorChapters();
    const filtered = (bookId ? chapters.filter(c => c.bookId === bookId) : chapters)
      .sort((a, b) => {
        const chapterA = Number(a.chapterNumber) || 0;
        const chapterB = Number(b.chapterNumber) || 0;
        if (chapterA !== chapterB) return chapterA - chapterB;
        return String(a.createdAt || '').localeCompare(String(b.createdAt || ''));
      });
    return { ok: true, chapters: filtered };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-add-chapter', async (_event, { bookId, chapterNumber, chapterName, contentUrlOrLink, fileData, fileName, imageUrl, imageData, imageFileName, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    if (!bookId) throw new Error('Vui lòng chọn quyển truyện.');
    if (!chapterNumber) throw new Error('Vui lòng nhập số chương.');
    if (!chapterName) throw new Error('Vui lòng nhập tên chương.');

    let finalContentLink = contentUrlOrLink || '';
    if (fileData && fileName) {
      finalContentLink = saveCreatorUploadedFile(fileData, fileName);
    }

    let finalImageUrl = imageUrl || '';
    if (imageData && imageFileName) {
      finalImageUrl = saveCreatorUploadedFile(imageData, imageFileName);
    }

    const chapters = readCreatorChapters();
    const newChapter = {
      id: `chapter_${Date.now()}`,
      bookId,
      chapterNumber,
      chapterName,
      contentUrlOrLink: finalContentLink,
      imageUrl: finalImageUrl,
      createdAt: new Date().toISOString()
    };

    chapters.push(newChapter);
    writeCreatorChapters(chapters);
    return { ok: true, chapter: newChapter };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-push-to-discovery', async (_event, { bookId, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    if (!bookId) throw new Error('ID truyện không hợp lệ.');
    
    const creatorBooks = readCreatorBooks();
    const creatorBook = creatorBooks.find(b => b.id === bookId);
    if (!creatorBook) throw new Error('Không tìm thấy truyện trong Creator Space.');
    
    const creatorChapters = readCreatorChapters().filter(c => c.bookId === bookId);
    creatorChapters.sort((a, b) => Number(a.chapterNumber) - Number(b.chapterNumber));
    
    const mappedChapters = [];
    for (const ch of creatorChapters) {
      let extractedText = '';
      const link = ch.contentUrlOrLink || '';
      
      if (link.startsWith('file://')) {
        // Local file - extract text directly
        extractedText = await extractTextFromFile(link);
      } else if (link.includes('docs.google.com/document/d/')) {
        // Google Docs link - try plain text export first, then PDF fallback
        try {
          const docIdMatch = link.match(/\/document\/d\/([a-zA-Z0-9_-]+)/);
          if (docIdMatch) {
            const docId = docIdMatch[1];
            let downloaded = false;
            
            // Attempt 1: Export as plain text (fastest, cleanest)
            try {
              const txtUrl = `https://docs.google.com/document/d/${docId}/export?format=txt`;
              const txtBuffer = await downloadFromUrl(txtUrl);
              const txtContent = txtBuffer.toString('utf8').trim();
              // Check if Google returned an HTML page (auth/error) instead of text
              if (txtContent && !txtContent.startsWith('<!DOCTYPE') && !txtContent.startsWith('<html')) {
                extractedText = txtContent;
                downloaded = true;
              }
            } catch { /* txt export failed, try PDF */ }
            
            // Attempt 2: Export as PDF and parse
            if (!downloaded) {
              try {
                const pdfUrl = `https://docs.google.com/document/d/${docId}/export?format=pdf`;
                const pdfBuffer = await downloadFromUrl(pdfUrl);
                // Verify it's actually a PDF (starts with %PDF)
                if (pdfBuffer.length > 4 && pdfBuffer.slice(0, 5).toString() === '%PDF-') {
                  const pdfResult = await pdfParse(pdfBuffer);
                  extractedText = pdfResult && pdfResult.text ? String(pdfResult.text).trim() : '';
                  if (extractedText) downloaded = true;
                }
              } catch { /* PDF export also failed */ }
            }
            
            if (!downloaded || !extractedText) {
              extractedText = '[Không trích xuất được nội dung. Hãy đảm bảo Google Docs đã được chia sẻ công khai (Anyone with the link).]';
            }
          } else {
            extractedText = '[Link Google Docs không hợp lệ]';
          }
        } catch (dlErr) {
          extractedText = `[Lỗi tải nội dung từ Google Docs: ${dlErr.message}]`;
        }
      } else if (link.includes('drive.google.com')) {
        // Google Drive link - download file and extract text
        try {
          const driveIdMatch = link.match(/\/d\/([a-zA-Z0-9_-]+)/) || link.match(/id=([a-zA-Z0-9_-]+)/);
          if (driveIdMatch) {
            const driveId = driveIdMatch[1];
            const driveUrl = `https://drive.google.com/uc?export=download&id=${driveId}`;
            const fileBuffer = await downloadFromUrl(driveUrl);
            
            // Check if Google returned an HTML page instead of a file
            const firstBytes = fileBuffer.slice(0, 20).toString('utf8');
            if (firstBytes.startsWith('<!DOCTYPE') || firstBytes.startsWith('<html')) {
              extractedText = '[Không tải được file. Hãy đảm bảo Google Drive đã được chia sẻ công khai (Anyone with the link).]';
            } else if (firstBytes.startsWith('%PDF-')) {
              // It's a PDF
              const pdfResult = await pdfParse(fileBuffer);
              extractedText = pdfResult && pdfResult.text ? String(pdfResult.text).trim() : '';
            } else if (fileBuffer[0] === 0x50 && fileBuffer[1] === 0x4B) {
              // It's a ZIP/DOCX
              const tmpPath = path.join(CREATOR_FILES_DIR, `tmp_${Date.now()}.docx`);
              fs.mkdirSync(CREATOR_FILES_DIR, { recursive: true });
              fs.writeFileSync(tmpPath, fileBuffer);
              try {
                const docRes = await mammoth.convertToHtml({ path: tmpPath });
                extractedText = docRes && docRes.value ? String(docRes.value) : '';
              } finally {
                try { fs.unlinkSync(tmpPath); } catch {}
              }
            } else {
              // Assume plain text
              extractedText = fileBuffer.toString('utf8').trim();
            }
            
            if (!extractedText) {
              extractedText = '[Không trích xuất được nội dung từ Google Drive]';
            }
          } else {
            extractedText = '[Link Google Drive không hợp lệ]';
          }
        } catch (dlErr) {
          extractedText = `[Lỗi tải nội dung từ Google Drive: ${dlErr.message}]`;
        }
      } else if (link) {
        extractedText = `[Liên kết bản thảo: ${link}]`;
      } else {
        extractedText = '[Chưa có nội dung]';
      }
      
      mappedChapters.push({
        id: ch.id,
        title: `Chương ${ch.chapterNumber}: ${ch.chapterName}`,
        text: extractedText,
        imageUrl: ch.imageUrl || ''
      });
    }
    const standardBook = {
      id: `creator_${creatorBook.id}`,
      title: creatorBook.title,
      coverUrl: creatorBook.coverUrl,
      description: creatorBook.description,
      chapters: mappedChapters,
      createdAt: creatorBook.createdAt || new Date().toISOString(),
      sourceUrl: 'Creator Space',
      text: mappedChapters.map(c => c.text).join('\n\n')
    };
    
    const baseUrl = getFirebaseDatabaseUrl();
    const data = await firebaseRequest(baseUrl, 'novelReader', { method: 'GET' }) || {};
    const remoteBooks = Array.isArray(data?.books) ? data.books : [];
    
    const existingIndex = remoteBooks.findIndex(b => b.id === standardBook.id);
    if (existingIndex >= 0) {
      remoteBooks[existingIndex] = standardBook;
    } else {
      remoteBooks.push(standardBook);
    }
    
    const payload = {
      ...data,
      updatedAt: new Date().toISOString(),
      books: remoteBooks
    };
    
    await firebaseRequest(baseUrl, 'novelReader', {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    
    const localBooks = readBooks();
    const localExistingIndex = localBooks.findIndex(b => b.id === standardBook.id);
    if (localExistingIndex >= 0) {
      localBooks[localExistingIndex] = normalizeBook(standardBook);
    } else {
      localBooks.push(normalizeBook(standardBook));
    }
    writeBooks(localBooks);
    
    return { ok: true, count: remoteBooks.length };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-delete-chapter', async (_event, { chapterId, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    if (!chapterId) throw new Error('ID chương không hợp lệ.');

    const chapters = readCreatorChapters();
    const index = chapters.findIndex(c => c.id === chapterId);
    if (index === -1) throw new Error('Không tìm thấy chương cần xóa.');

    // Remove the chapter
    chapters.splice(index, 1);
    writeCreatorChapters(chapters);

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('creator-update-chapters-order', async (_event, { bookId, chapterIds, currentEmail }) => {
  try {
    await requireAdminUser(currentEmail);
    if (!bookId) throw new Error('ID truyện không hợp lệ.');
    if (!Array.isArray(chapterIds)) throw new Error('Danh sách thứ tự chương không hợp lệ.');

    const chapters = readCreatorChapters();
    
    // Separate book's chapters and other chapters
    const bookChapters = chapters.filter(c => c.bookId === bookId);
    const otherChapters = chapters.filter(c => c.bookId !== bookId);

    // Map chapters of this book by ID for quick lookup
    const chMap = new Map(bookChapters.map(c => [c.id, c]));

    // Reconstruct the sorted list of chapters for this book
    const sortedBookChapters = [];
    chapterIds.forEach((id, index) => {
      const ch = chMap.get(id);
      if (ch) {
        // Gán lại chapterNumber theo thứ tự index mới (1-based index)
        ch.chapterNumber = index + 1;
        sortedBookChapters.push(ch);
      }
    });

    // Add any remaining chapters that weren't included in chapterIds just in case
    bookChapters.forEach(ch => {
      if (!chapterIds.includes(ch.id)) {
        ch.chapterNumber = sortedBookChapters.length + 1;
        sortedBookChapters.push(ch);
      }
    });

    // Merge everything back
    const finalChapters = [...otherChapters, ...sortedBookChapters];
    writeCreatorChapters(finalChapters);

    return { ok: true };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});

ipcMain.handle('update-book-chapters', async (_event, { bookId, chapters }) => {
  try {
    if (!bookId) throw new Error('ID truyện không hợp lệ.');
    if (!Array.isArray(chapters)) throw new Error('Danh sách chương không hợp lệ.');

    const books = readBooks();
    const index = books.findIndex(b => b.id === bookId);
    if (index === -1) throw new Error('Không tìm thấy truyện trong thư viện.');

    const book = books[index];
    book.chapters = chapters;

    // Recalculate full text and lengths
    const fullText = chapters.map(c => c.text || '').join('\n\n');
    book.text = fullText;
    book.translatedLength = fullText.length;

    // Save updated books list
    books[index] = normalizeBook(book);
    writeBooks(books);

    // Trigger Firebase sync automatically
    await autoSyncAllData();

    return { ok: true, book: books[index] };
  } catch (error) {
    return { ok: false, error: error.message };
  }
});
