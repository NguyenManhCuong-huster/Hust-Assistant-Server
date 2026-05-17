FROM node:24-alpine
WORKDIR /app

# Copy package.json + lock (nếu có). Lock file không bắt buộc — `npm install`
# sẽ tự resolve và sinh lock mới trong container nếu thiếu hoặc out-of-sync.
COPY server/package*.json ./

# Dùng `npm install --omit=dev` thay vì `npm ci` vì:
#   • Khi thêm dependency mới (vd cheerio) ở host mà chưa chạy `npm install`
#     để update lock thì `npm ci` sẽ fail (package.json vs lock không khớp).
#   • `npm install` linh hoạt hơn: lock có sẵn → honor; thiếu/lệch → tự update.
#   • Tradeoff: build hơi chậm hơn `ci` và versions có thể drift giữa các build
#     nếu không pin chặt. Cho production thật thì commit lock file rồi đổi lại
#     `npm ci` để đảm bảo reproducible.
#
# `npm cache clean` giảm size image cuối ~30-50MB.
RUN npm install --omit=dev && npm cache clean --force

# Copy source code (đặt sau install để cache layer install không bị invalidate
# mỗi lần đổi src/)
COPY server/src ./src

EXPOSE 3000

CMD ["node", "src/app.js"]