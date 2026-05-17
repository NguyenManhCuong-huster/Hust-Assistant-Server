/**
 * src/services/newsScrapeService.js
 *
 * Cào TIN TỨC + KẾ HOẠCH từ HUST CTT (https://ctt.hust.edu.vn/).
 *
 * THAY ĐỔI 2026-05-08:
 *  • Cào CẢ 2 loại item từ trang chủ:
 *      - .info.w-left  → KẾ HOẠCH (kind='PLAN', URL /DisplayKehoach?kehoach=...)
 *      - .info.w-right → TIN TỨC  (kind='NEWS', URL /DisplayBaiViet?baiviet=...)
 *    Lưu chung bảng `news`, phân biệt qua cột `kind`.
 *  • Chỉ extract plain text (không HTML).
 *  • Resilient: cào trang chi tiết fail → fallback dùng title làm summary.
 *
 * Flow:
 *   1) scrapeHomepage() → preview list của cả 2 loại, dedup theo URL.
 *   2) Với mỗi preview, cào trang chi tiết → extract plain text.
 *   3) Upsert qua ON CONFLICT (article_url) DO UPDATE.
 */

import * as cheerio from 'cheerio';

import { query } from '../config/db.js';

const BASE_URL    = 'https://ctt.hust.edu.vn';
const HOMEPAGE    = 'https://ctt.hust.edu.vn/';
const SOURCE_NAME = 'HUST CTT';
const USER_AGENT  = 'Mozilla/5.0 (compatible; HustNotificationAggregator/1.0)';
const DETAIL_DELAY_MS = 400;

const KIND_NEWS = 'NEWS';
const KIND_PLAN = 'PLAN';

// ─────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────

const fetchHtml = async (url) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const absUrl = (href) => {
  if (!href) return null;
  if (/^https?:\/\//i.test(href)) return href;
  if (href.startsWith('/'))       return BASE_URL + href;
  return `${BASE_URL}/${href}`;
};

/** "5/5/2026" | "05.05.2026" | "27/04/2026" → Date | null */
const parseVnDate = (raw) => {
  if (!raw) return null;
  const m = String(raw).trim().match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isFinite(date.getTime()) ? date : null;
};

/**
 * "[CTSV]KẾT QUẢ XÉT..." → { tag: 'CTSV', title: 'KẾT QUẢ XÉT...' }
 * "[DTDH] LỊCH THI..."   → { tag: 'DTDH', title: 'LỊCH THI...' }
 * "Title không tag"      → { tag: null,   title: 'Title không tag' }
 */
const parseTitleAndTag = (raw) => {
  if (!raw) return { tag: null, title: '' };
  const m = String(raw).match(/^\s*\[([^\]]+)\]\s*(.+?)\s*$/);
  if (m) return { tag: m[1].trim().toUpperCase(), title: m[2].trim() };
  return { tag: null, title: raw.trim() };
};

const normalizeText = (text) => {
  if (!text) return '';
  return text
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
};

// ─────────────────────────────────────────────────────────
// Scrapers
// ─────────────────────────────────────────────────────────

/**
 * Parse 1 panel (KẾ HOẠCH hoặc TIN TỨC) trong 1 tab.
 * Hai panel cấu trúc gần giống — chỉ khác:
 *   • PLAN  có .month + .date (không có <img>)
 *   • NEWS  có <img> (không có .month/.date)
 *   • datetime có thể nằm trong <a> (PLAN) hoặc bên ngoài <a> (NEWS)
 * → selector dùng được cho cả 2 nhờ `.first()` fallback.
 */
const parsePanelItems = ($, $panel, kind) => {
  const items = [];
  $panel.find('.content .item').each((_, el) => {
    const $el  = $(el);
    const $a   = $el.find('a').first();
    const href = $a.attr('href');
    if (!href) return;

    const dateText = $el.find('.datetime').first().text() ||
                     $a.find('.datetime').first().text();
    const titleRaw = $a.find('.title').text();
    const { tag, title } = parseTitleAndTag(titleRaw);

    items.push({
      kind,
      title,
      tag,
      url:          absUrl(href),
      published_at: parseVnDate(dateText),
      image_url:    absUrl($el.find('img').attr('src')),
    });
  });
  return items;
};

/**
 * Cào trang chủ HUST → list preview của CẢ TIN TỨC và KẾ HOẠCH.
 * Đã dedup theo URL.
 */
export const scrapeHomepage = async () => {
  const html = await fetchHtml(HOMEPAGE);
  const $    = cheerio.load(html);
  const all  = [];

  // 4 panel (Tổng hợp/ĐTĐH/ĐTSĐH/VLVH)
  $('.panel').each((_, panelEl) => {
    const $panel = $(panelEl);
    all.push(...parsePanelItems($, $panel.find('.info.w-left'),  KIND_PLAN));
    all.push(...parsePanelItems($, $panel.find('.info.w-right'), KIND_NEWS));
  });

  // Dedup theo URL (panel "Tổng hợp" thường lặp bài từ panel chuyên ngành)
  const seen  = new Set();
  const dedup = all.filter((it) => {
    if (!it.url || seen.has(it.url)) return false;
    seen.add(it.url);
    return true;
  });

  const newsCount = dedup.filter((i) => i.kind === KIND_NEWS).length;
  const planCount = dedup.filter((i) => i.kind === KIND_PLAN).length;
  console.log(
    `[news scrape] homepage: ${all.length} raw → ${dedup.length} unique ` +
    `(${newsCount} NEWS, ${planCount} PLAN)`,
  );
  return dedup;
};

/**
 * Cào trang chi tiết — trả về { title, summary (plain text) }.
 * Cùng selector cho cả NEWS và PLAN (HUST dùng layout chung).
 */
export const scrapeArticle = async (url) => {
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  $('script, style, header, nav, footer, .navigation, .breadcrumb, .menu, .sidebar').remove();

  const candidates = [
    '.content-baiviet',
    '.detail-content',
    '.content-detail',
    '#content-baiviet',
    'article',
    'main',
    '.container .content',
  ];
  let $body = null;
  for (const sel of candidates) {
    const $found = $(sel);
    if ($found.length && $found.text().trim().length > 50) {
      $body = $found.first();
      break;
    }
  }
  if (!$body) {
    const $h3 = $('h3').first();
    $body = $h3.length ? $h3.parent() : $('body');
  }

  const title =
    $body.find('h1, h2, h3').first().text().trim() ||
    $('title').text().replace(/CTT ĐHBKHN\s*[-|]?\s*/i, '').trim();

  const summary = normalizeText($body.text());

  return { title, summary };
};

// ─────────────────────────────────────────────────────────
// DB sync
// ─────────────────────────────────────────────────────────

const getSourceId = async () => {
  const r = await query('SELECT id FROM news_sources WHERE name = $1', [SOURCE_NAME]);
  if (!r.rows[0]) {
    throw new Error(
      `news_sources không có row "${SOURCE_NAME}". ` +
      'Chạy migration 004 trước.',
    );
  }
  return r.rows[0].id;
};

const upsertNews = async (sourceId, item) => {
  const r = await query(
    `INSERT INTO news
       (source_id, kind, title, summary, article_url, image_url, tag, published_at, mod_time)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
     ON CONFLICT (article_url) DO UPDATE SET
       kind         = EXCLUDED.kind,
       title        = EXCLUDED.title,
       summary      = EXCLUDED.summary,
       image_url    = EXCLUDED.image_url,
       tag          = EXCLUDED.tag,
       published_at = COALESCE(EXCLUDED.published_at, news.published_at),
       mod_time     = CURRENT_TIMESTAMP,
       is_deleted   = FALSE
     RETURNING (xmax = 0) AS inserted`,
    [
      sourceId,
      item.kind,
      item.title,
      item.summary,
      item.url,
      item.image_url,
      item.tag,
      item.published_at,
    ],
  );
  return r.rows[0].inserted ? 'created' : 'updated';
};

/**
 * Cào và sync. Resilient — fail 1 bài không kill cả batch.
 *
 * @param {object} options
 * @param {boolean} options.refetchExisting  Mặc định false: bỏ qua bài đã có summary đủ dài.
 * @param {number}  options.limit            Tối đa N bài mỗi lần (default 50).
 */
export const syncNews = async ({ refetchExisting = false, limit = 50 } = {}) => {
  const sourceId = await getSourceId();
  const previews = (await scrapeHomepage()).slice(0, limit);

  let created = 0, updated = 0, skipped = 0, failed = 0;

  for (const p of previews) {
    try {
      const existing = await query(
        'SELECT id, summary FROM news WHERE article_url = $1',
        [p.url],
      );
      const hasSummary = existing.rows[0] && existing.rows[0].summary && existing.rows[0].summary.length > 100;
      if (hasSummary && !refetchExisting) { skipped++; continue; }

      let detail;
      try {
        detail = await scrapeArticle(p.url);
        await sleep(DETAIL_DELAY_MS);
      } catch (e) {
        console.warn(`[news scrape] detail fail ${p.url}: ${e.message} (fallback to preview)`);
        detail = { title: null, summary: p.title };
      }

      const status = await upsertNews(sourceId, {
        kind:         p.kind,
        title:        detail.title || p.title || '(không có tiêu đề)',
        summary:      detail.summary || p.title,
        url:          p.url,
        image_url:    p.image_url,
        tag:          p.tag,
        published_at: p.published_at,
      });
      if (status === 'created') created++; else updated++;
    } catch (err) {
      console.error(`[news scrape] upsert fail ${p.url}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `[news scrape] DONE total=${previews.length} created=${created} ` +
    `updated=${updated} skipped=${skipped} failed=${failed}`,
  );
  return { total: previews.length, created, updated, skipped, failed };
};
