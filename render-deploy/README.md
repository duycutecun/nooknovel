# PWA Novel Reader (Starter)

Hướng dẫn nhanh (Tiếng Việt):

1. Cài đặt
   - Mở hai terminal:
     a) Frontend: cd client && npm install
     b) Backend: cd server && npm install

2. Chạy và build
   - Frontend dev: cd client && npm run dev
   - Hoặc build: cd client && npm run build
   - Phục vụ build từ server: copy dist sang server/public hoặc chạy server điểm truy cập.

3. Expose với ngrok (HTTPS):
   - ngrok http 3000
   - Trên iPhone mở URL https://... ngrok cung cấp, chọn "Add to Home Screen" trong Safari để cài PWA.

4. Kết nối WebSocket: frontend sẽ kết nối tới server (wss nếu dùng ngrok HTTPS).

Các lệnh ví dụ có trong package.json của client và server.