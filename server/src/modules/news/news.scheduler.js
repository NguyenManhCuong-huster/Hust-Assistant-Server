import { syncNews as syncCttNews }   from './news.scraper.js';
import { syncNews as syncSoictNews } from './news.soict-scraper.js';

// ─── Config (đặt chung cho cả 2 source — đơn giản hoá ENV) ───────────
// ENV overrides (mặc định: 1 giờ/lần, không cào lại bài đã có content)
const INTERVAL_MS       = Number(process.env.NEWS_SCRAPE_INTERVAL_MS)   || 60 * 60 * 1000;
const ITEMS_PER_RUN     = Number(process.env.NEWS_SCRAPE_LIMIT)         || 50;
const REFETCH_EXISTING  = process.env.NEWS_SCRAPE_REFETCH === 'true';
const ENABLED           = process.env.NEWS_SCRAPE_ENABLED !== 'false';   // default ON

// SoICT-specific: số page tối đa cào mỗi category mỗi tick (default 5 = ~50 bài/cat).
const SOICT_MAX_PAGES   = Number(process.env.NEWS_SCRAPE_SOICT_MAX_PAGES) || 5;

// Bật/tắt từng source riêng (vd dev chỉ muốn test 1 source).
// Default: cả 2 cùng ON khi ENABLED=true.
const CTT_ENABLED       = process.env.NEWS_SCRAPE_CTT_ENABLED   !== 'false';
const SOICT_ENABLED     = process.env.NEWS_SCRAPE_SOICT_ENABLED !== 'false';

let timer = null;
let running = false; // Tránh chạy chồng nếu lần trước chưa xong

/**
 * Chạy sync cho 1 source. Resilient — exception KHÔNG được phép propagate
 * lên `runOnce`, vì 1 source fail không nên block source kia.
 */
const runSource = async (label, fn) => {
  try {
    const result = await fn();
    console.log(`[news scheduler] ${label} OK:`, result);
  } catch (err) {
    console.error(`[news scheduler] ${label} FAILED:`, err.message);
  }
};

const runOnce = async () => {
  if (running) {
    console.warn('[news scheduler] previous run still in progress, skip this tick');
    return;
  }
  running = true;
  try {
    // Chạy tuần tự (KHÔNG dùng Promise.all) để tránh:
    //   1. Spike CPU/RAM (cheerio + downloadAndSave)
    //   2. Tranh chấp connection pool PostgreSQL
    //   3. Log interleaved khó debug
    if (CTT_ENABLED) {
      await runSource('CTT', () => syncCttNews({
        refetchExisting: REFETCH_EXISTING,
        limit:           ITEMS_PER_RUN,
      }));
    }
    if (SOICT_ENABLED) {
      await runSource('SOICT', () => syncSoictNews({
        refetchExisting: REFETCH_EXISTING,
        limit:           ITEMS_PER_RUN,
        maxPages:        SOICT_MAX_PAGES,
      }));
    }
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
    `limit=${ITEMS_PER_RUN} refetch=${REFETCH_EXISTING} ` +
    `sources={CTT:${CTT_ENABLED}, SOICT:${SOICT_ENABLED}}`,
  );
};

export const stopNewsScheduler = () => {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
};
