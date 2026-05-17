/**
 * src/services/newsScrapeScheduler.js
 *
 * Tick định kỳ cào tin. Đặt riêng khỏi newsScrapeService.js để dễ:
 *   • Stub trong test (chỉ start scheduler khi NODE_ENV=production)
 *   • Tắt qua env var nếu deploy nhiều instance (chỉ 1 instance nên cào)
 *
 * Sử dụng setInterval thay vì node-cron để khỏi thêm dependency:
 *   - Đủ cho yêu cầu "mỗi N giờ chạy 1 lần".
 *   - Nếu sau này cần biểu thức cron phức tạp → thay bằng node-cron.
 */

import { syncNews } from './newsScrapeService.js';

// ENV overrides (mặc định: 1 giờ/lần, không cào lại bài đã có content)
const INTERVAL_MS       = Number(process.env.NEWS_SCRAPE_INTERVAL_MS)   || 60 * 60 * 1000;
const ITEMS_PER_RUN     = Number(process.env.NEWS_SCRAPE_LIMIT)         || 50;
const REFETCH_EXISTING  = process.env.NEWS_SCRAPE_REFETCH === 'true';
const ENABLED           = process.env.NEWS_SCRAPE_ENABLED !== 'false';   // default ON

let timer = null;
let running = false; // Tránh chạy chồng nếu lần trước chưa xong

const runOnce = async () => {
  if (running) {
    console.warn('[news scheduler] previous run still in progress, skip this tick');
    return;
  }
  running = true;
  try {
    await syncNews({ refetchExisting: REFETCH_EXISTING, limit: ITEMS_PER_RUN });
  } catch (err) {
    console.error('[news scheduler] run failed:', err.message);
  } finally {
    running = false;
  }
};

export const startNewsScheduler = () => {
  if (!ENABLED) {
    console.log('[news scheduler] disabled via NEWS_SCRAPE_ENABLED=false');
    return;
  }
  if (timer) return; // idempotent

  // Chạy 1 lần ngay khi server start để có dữ liệu
  // Delay nhỏ để khỏi block startup nếu DB chưa kịp ready
  setTimeout(runOnce, 5_000);

  timer = setInterval(runOnce, INTERVAL_MS);
  console.log(
    `[news scheduler] started; interval=${Math.round(INTERVAL_MS / 60000)}min ` +
    `limit=${ITEMS_PER_RUN} refetch=${REFETCH_EXISTING}`,
  );
};

export const stopNewsScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
