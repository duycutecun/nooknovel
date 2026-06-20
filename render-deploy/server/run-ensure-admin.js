const https = require('https');
const crypto = require('crypto');

const dbUrl = 'https://nooknovel-7b5a1-default-rtdb.asia-southeast1.firebasedatabase.app';

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}
function generateSalt() { return crypto.randomBytes(16).toString('hex'); }
function safeFirebasePath(value) {
  return String(value || '').trim().toLowerCase().replace(/[.$#[\]\/]/g, '_');
}

async function firebaseRequest(baseUrl, pathName, options = {}) {
  const url = `${baseUrl}/${pathName.replace(/^\/+/, '')}.json`;
  const method = options.method || 'GET';
  const body = options.body || '';

  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Firebase ${res.statusCode}: ${data}`));
        }
        try { resolve(data ? JSON.parse(data) : null); } catch { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function run() {
  try {
    console.log('Fetching users...');
    const data = await firebaseRequest(dbUrl, 'novelReader/users');
    console.log('Fetched data type:', Array.isArray(data) ? 'Array' : typeof data);
    console.log('Fetched data:', JSON.stringify(data, null, 2));

    const users = Array.isArray(data) ? data : Object.values(data || {});
    let admin = users.find(u => u.email === 'admin');
    const defaultPwd = '123321Oki';
    
    const salt = generateSalt();
    const passwordHash = hashPassword(defaultPwd, salt);

    if (!admin) {
      console.log('Admin not found, creating...');
      admin = { email: 'admin', provider: 'local', role: 'admin', createdAt: new Date().toISOString(), salt, passwordHash };
      users.push(admin);
    } else {
      console.log('Admin found, updating salt and hash...');
      admin.salt = salt;
      admin.passwordHash = passwordHash;
      admin.role = 'admin';
      admin.provider = 'local';
    }

    // Prepare object for saving
    const obj = users.reduce((acc, u) => {
      const k = safeFirebasePath(u.email);
      if (k) acc[k] = u;
      return acc;
    }, {});

    console.log('Saving users back as object:', JSON.stringify(obj, null, 2));
    await firebaseRequest(dbUrl, 'novelReader/users', { method: 'PUT', body: JSON.stringify(obj) });
    console.log('Save successful!');
  } catch (err) {
    console.error('Error running check:', err);
  }
}

run();
