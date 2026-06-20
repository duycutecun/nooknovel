const https = require('https');
const crypto = require('crypto');

function hashPassword(password, salt) {
  return crypto.pbkdf2Sync(password, salt, 120000, 64, 'sha512').toString('hex');
}

const dbUrl = 'https://nooknovel-7b5a1-default-rtdb.asia-southeast1.firebasedatabase.app/novelReader/users.json';

https.get(dbUrl, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    try {
      const users = JSON.parse(data);
      const userList = Array.isArray(users) ? users : Object.values(users);
      const admin = userList.find(u => u.email === 'admin');
      
      console.log('Admin User:', JSON.stringify(admin, null, 2));
      
      if (admin) {
        const testPwd = '123321Oki';
        const testHash = hashPassword(testPwd, admin.salt || '');
        console.log('Testing Password:', testPwd);
        console.log('Calculated Hash:', testHash);
        console.log('Stored Hash:    ', admin.passwordHash);
        console.log('Match?          ', testHash === admin.passwordHash);
      } else {
        console.log('Admin user not found in the list!');
      }
    } catch (e) {
      console.error('Parsing error:', e.message);
    }
  });
});
