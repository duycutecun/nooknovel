/*
  Script: firebase-admin-push.js
  Mục đích: Đọc các file truyện trong server/novels và upload vào Firestore collection `novels`.
  Yêu cầu: đặt service account JSON tại server/serviceAccountKey.json (không commit file này).
  Sử dụng: node firebase-admin-push.js
*/

const fs = require('fs');
const path = require('path');
const admin = require('firebase-admin');

const saPath = path.join(__dirname, 'serviceAccountKey.json');
if (!fs.existsSync(saPath)) {
  console.error('serviceAccountKey.json không tồn tại. Tạo và đặt ở server/serviceAccountKey.json');
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(saPath))
});

const db = admin.firestore();
const novelsDir = path.join(__dirname, 'novels');

if (!fs.existsSync(novelsDir)) {
  console.error('Thư mục server/novels không tồn tại. Tạo và bỏ các file .txt truyện vào.');
  process.exit(1);
}

async function uploadAll() {
  const files = fs.readdirSync(novelsDir).filter(f => f.endsWith('.txt'));
  if (files.length === 0) { console.log('Không tìm thấy file .txt trong server/novels'); return }
  for (const file of files) {
    const full = path.join(novelsDir, file);
    const title = path.basename(file, '.txt');
    const content = fs.readFileSync(full, 'utf8');
    const docRef = db.collection('novels').doc(title);
    await docRef.set({ title, content, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    console.log('Uploaded', title);
  }
}

uploadAll().then(()=>process.exit(0)).catch(e=>{console.error(e); process.exit(1) });
