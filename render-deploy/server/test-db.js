const https = require('https');

const dbUrl = 'https://nooknovel-7b5a1-default-rtdb.asia-southeast1.firebasedatabase.app/novelReader/users.json';

https.get(dbUrl, (res) => {
  let data = '';
  res.on('data', chunk => data += chunk);
  res.on('end', () => {
    console.log('Status Code:', res.statusCode);
    console.log('Response:', data);
  });
}).on('error', (err) => {
  console.error('Error:', err.message);
});
