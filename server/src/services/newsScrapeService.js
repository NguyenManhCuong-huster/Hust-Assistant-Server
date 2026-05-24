import * as cheerio from 'cheerio';

import { query } from '../config/db.js';
import * as att  from './attachmentService.js';

const BASE_URL    = 'https://ctt.hust.edu.vn';
const HOMEPAGE    = 'https://ctt.hust.edu.vn/';
const SOURCE_NAME = 'HUST CTT';
const USER_AGENT  = 'Mozilla/5.0 (compatible; HustNotificationAggregator/1.0)';
const DETAIL_DELAY_MS = 400;

const KIND_NEWS = 'NEWS';
const KIND_PLAN = 'PLAN';

// Extension được coi là "file đính kèm" (regex case-insensitive, có thể có ?query).
const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|jpe?g|png|gif|bmp|svg)(\?.*)?$/i;

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
  if (href.startsWith('//'))       return 'https:' + href;
  if (href.startsWith('/'))        return BASE_URL + href;
  return `${BASE_URL}/${href}`;
};

const parseVnDate = (raw) => {
  if (!raw) return null;
  const m = String(raw).trim().match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (!m) return null;
  const [, d, mo, y] = m;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return Number.isFinite(date.getTime()) ? date : null;
};

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

/** Extract tên file từ URL hoặc anchor text. */
const fileNameFromUrl = (url, anchorText) => {
  try {
    const u = new URL(url, BASE_URL);
    const pathPart = u.pathname.split('/').filter(Boolean).pop();
    if (pathPart && FILE_EXT_RE.test(pathPart)) return decodeURIComponent(pathPart);
  } catch {/* fallthrough */}
  // Fallback: dùng anchor text + extension đoán từ URL
  const ext = (url.match(FILE_EXT_RE) || [''])[0].replace(/^\./, '').replace(/\?.*$/, '');
  const base = (anchorText || 'file').trim().replace(/\s+/g, '_');
  return ext ? `${base}.${ext}` : base;
};

// ─────────────────────────────────────────────────────────
// Scrapers
// ─────────────────────────────────────────────────────────

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

export const scrapeHomepage = async () => {
  const html = await fetchHtml(HOMEPAGE);
  const $    = cheerio.load(html);
  const all  = [];

  $('.panel').each((_, panelEl) => {
    const $panel = $(panelEl);
    all.push(...parsePanelItems($, $panel.find('.info.w-left'),  KIND_PLAN));
    all.push(...parsePanelItems($, $panel.find('.info.w-right'), KIND_NEWS));
  });

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
 * Cào trang chi tiết — trả { title, summary, files }.
 * - `files`: list anchor link trỏ tới file (PDF, Word, Excel, hình ảnh, archive).
 * - Phải tìm files TRƯỚC khi remove HTML/strip body.
 */
export const scrapeArticle = async (url) => {
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  // ── Bước 1: Tìm body candidates (để giới hạn scope tìm file) ──
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

  // ── Bước 2: Extract file links TRƯỚC khi strip ──
  const files = [];
  const seenUrls = new Set();
  $body.find('a[href]').each((_, el) => {
    const $a   = $(el);
    const href = $a.attr('href');
    if (!href) return;
    if (!FILE_EXT_RE.test(href)) return;

    const abs = absUrl(href);
    if (!abs || seenUrls.has(abs)) return;
    seenUrls.add(abs);

    const anchorText = $a.text().trim() || $a.attr('title') || null;
    files.push({
      url:  abs,
      name: fileNameFromUrl(abs, anchorText),
    });
  });
  // Cũng tìm trong <img> nếu user nhúng hình lớn (rare nhưng có thể)
  $body.find('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    if (!FILE_EXT_RE.test(src)) return;
    const abs = absUrl(src);
    if (!abs || seenUrls.has(abs)) return;
    // Bỏ qua hình quá nhỏ (icon UI). Heuristic: width/height attr.
    const w = Number.parseInt($(el).attr('width'), 10);
    const h = Number.parseInt($(el).attr('height'), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w < 100 && h < 100) return;
    seenUrls.add(abs);
    files.push({ url: abs, name: fileNameFromUrl(abs, $(el).attr('alt')) });
  });

  // ── Bước 3: Strip + extract plain text ──
  // Re-load để strip không ảnh hưởng files đã thu thập (chỉ strip $body in-place)
  $body.find('script, style, header, nav, footer, .navigation, .breadcrumb, .menu, .sidebar')
    .remove();

  const title =
    $body.find('h1, h2, h3').first().text().trim() ||
    $('title').text().replace(/CTT ĐHBKHN\s*[-|]?\s*/i, '').trim();

  const summary = normalizeText($body.text());

  return { title, summary, files };
};

// ─────────────────────────────────────────────────────────
// DB sync
// ─────────────────────────────────────────────────────────

const getSourceId = async () => {
  const r = await query('SELECT id FROM news_sources WHERE name = $1', [SOURCE_NAME]);
  if (!r.rows[0]) {
    throw new Error(
      `news_sources không có row "${SOURCE_NAME}". Chạy migration 004 trước.`,
    );
  }
  return r.rows[0].id;
};

/** Upsert news, trả `{ newsId, status }`. */
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
     RETURNING id, (xmax = 0) AS inserted`,
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
  return { newsId: r.rows[0].id, status: r.rows[0].inserted ? 'created' : 'updated' };
};

/**
 * Download các file đính kèm cho 1 news row. Resilient.
 */
const downloadNewsFiles = async (newsId, files) => {
  let downloaded = 0;
  let failed     = 0;
  let skipped    = 0;

  for (const f of files) {
    try {
      // Check đã có chưa
      const existing = await query(
        `SELECT storage_path FROM attachments
          WHERE owner_type = 'NEWS' AND owner_id = $1 AND source_url = $2 AND is_deleted = FALSE`,
        [newsId, f.url],
      );
      if (existing.rows[0]?.storage_path) { skipped++; continue; }

      await att.downloadAndSave({
        ownerType:  att.OWNER_NEWS,
        ownerId:    newsId,
        fileName:   f.name,
        sourceUrl:  f.url,
        headers:    { 'User-Agent': USER_AGENT },
      });
      downloaded++;
    } catch (e) {
      // attachmentService đã upsert metadata-only trong nhiều case → vẫn có chip
      console.warn(`[news scrape] file fail ${f.url}: ${e.message}`);
      failed++;
    }
  }
  return { downloaded, failed, skipped };
};

/**
 * Cào và sync. Resilient.
 *
 * @param {object} options
 * @param {boolean} options.refetchExisting  Mặc định false: bỏ qua bài đã có summary đủ dài.
 * @param {number}  options.limit            Tối đa N bài mỗi lần (default 50).
 * @param {boolean} options.skipFiles        Bỏ qua download file (test/debug).
 */
export const syncNews = async ({ refetchExisting = false, limit = 50, skipFiles = false } = {}) => {
  const sourceId = await getSourceId();
  const previews = (await scrapeHomepage()).slice(0, limit);

  let created = 0, updated = 0, skipped = 0, failed = 0;
  let filesDownloaded = 0, filesFailed = 0;

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
        detail = { title: null, summary: p.title, files: [] };
      }

      const { newsId, status } = await upsertNews(sourceId, {
        kind:         p.kind,
        title:        detail.title || p.title || '(không có tiêu đề)',
        summary:      detail.summary || p.title,
        url:          p.url,
        image_url:    p.image_url,
        tag:          p.tag,
        published_at: p.published_at,
      });
      if (status === 'created') created++; else updated++;

      // ── Files ──
      if (!skipFiles && detail.files && detail.files.length > 0) {
        const r = await downloadNewsFiles(newsId, detail.files);
        filesDownloaded += r.downloaded;
        filesFailed     += r.failed;
      }
    } catch (err) {
      console.error(`[news scrape] upsert fail ${p.url}: ${err.message}`);
      failed++;
    }
  }

  console.log(
    `[news scrape] DONE total=${previews.length} created=${created} ` +
    `updated=${updated} skipped=${skipped} failed=${failed} ` +
    `files_downloaded=${filesDownloaded} files_failed=${filesFailed}`,
  );
  return {
    total: previews.length, created, updated, skipped, failed,
    files_downloaded: filesDownloaded, files_failed: filesFailed,
  };
};
