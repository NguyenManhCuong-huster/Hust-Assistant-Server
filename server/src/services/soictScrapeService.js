/**
 * soictScrapeService.js — Scrape news/announcements from SoICT website.
 *
 * Nguồn: https://soict.hust.edu.vn/  (Trường CNTT&TT — ĐHBK Hà Nội)
 * Tech stack target: WordPress 6.5.x + Flatsome theme.
 *
 * Khác với CTT (newsScrapeService.js):
 *  - SoICT là WordPress chuẩn → có Open Graph + article:published_time meta tags
 *    rất sạch. Ưu tiên đọc meta thay vì parse ngày tiếng Việt "20 Th5".
 *  - 2 sub-category rõ ràng:
 *      /tin-tuc/thong-bao  →  Thông báo  (kind='PLAN', tag='TB')
 *      /tin-tuc/tin-bai    →  Tin bài    (kind='NEWS', tag='TB')
 *    Crawl tách riêng để biết kind từ URL listing, không phải parse breadcrumb.
 *  - Paginated: /page/2, /page/3, ...
 *
 * Sử dụng chung với CTT:
 *  - news_sources row "HUST SOICT" (seed bởi migration 005)
 *  - Bảng news (cùng schema, source_id phân biệt)
 *  - attachmentService.downloadAndSave (owner_type='NEWS')
 *  - newsRecommendationService chạy trên TẤT CẢ news, không phân biệt source
 */

import * as cheerio from 'cheerio';

import { query } from '../config/db.js';
import * as att  from './attachmentService.js';

const BASE_URL    = 'https://soict.hust.edu.vn';
const SOURCE_NAME = 'HUST SOICT';
const USER_AGENT  = 'Mozilla/5.0 (compatible; HustNotificationAggregator/1.0)';
const DETAIL_DELAY_MS = 400;

const KIND_NEWS = 'NEWS';
const KIND_PLAN = 'PLAN';

// Hai sub-category. Thứ tự định nghĩa ở đây = thứ tự crawl.
// Thông báo lên trước vì thường actionable (deadline, kế hoạch...) — sinh viên
// quan tâm hơn tin bài (lễ kỷ niệm, hội thảo...).
const CATEGORIES = [
  { path: '/tin-tuc/thong-bao', kind: KIND_PLAN, tag: 'TB' },  // Thông báo
  { path: '/tin-tuc/tin-bai',   kind: KIND_NEWS, tag: 'TB' },  // Tin bài
];

// Cùng regex với CTT scraper — file extensions được coi là "đính kèm".
const FILE_EXT_RE = /\.(pdf|docx?|xlsx?|pptx?|zip|rar|7z|csv|txt|jpe?g|png|gif|bmp|svg)(\?.*)?$/i;

// URL patterns KHÔNG phải bài viết (loại bỏ khỏi listing scrape).
// Các đường dẫn này là category/listing/department page, không phải article.
const NON_ARTICLE_PATH_RE = /\/(category|tin-tuc|su-kien|bo-phan|sinh-vien|en|dao-tao|nghien-cuu|tuyen-sinh|hop-tac-doi-ngoai|tuyen-dung|wp-content|wp-admin|wp-login|wp-json|page|feed)(\/|$|\?|#)/i;

// ─────────────────────────────────────────────────────────
// Helpers (gần giống CTT scraper — có thể refactor về shared util sau)
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
  const ext = (url.match(FILE_EXT_RE) || [''])[0].replace(/^\./, '').replace(/\?.*$/, '');
  const base = (anchorText || 'file').trim().replace(/\s+/g, '_');
  return ext ? `${base}.${ext}` : base;
};

/**
 * Strip WordPress thumbnail size suffix để so sánh "cùng ảnh, khác variant".
 *
 * WP tự sinh nhiều biến thể của 1 ảnh upload:
 *   foo.jpg                ← original
 *   foo-scaled.jpg         ← scaled-down nếu vượt 2560px
 *   foo-1024x576.jpg       ← responsive variant
 *   foo-400x225.jpg        ← thumbnail variant
 *
 * og:image thường trỏ tới `-scaled`, body inline lại nhúng `-1024x576` →
 * cùng ảnh nhưng URL khác. Strip suffix để so sánh chính xác.
 */
const stripWpSizeSuffix = (url) => {
  if (!url) return url;
  return url
    .split('?')[0]
    .replace(/-\d+x\d+(\.[a-zA-Z0-9]+)$/, '$1')
    .replace(/-scaled(\.[a-zA-Z0-9]+)$/, '$1');
};

/** Helper đọc meta tag (cả `property` và `name` attribute). */
const getMeta = ($, key) => {
  const v = $(`meta[property="${key}"]`).attr('content')
         || $(`meta[name="${key}"]`).attr('content');
  return v ? v.trim() : null;
};

// ─────────────────────────────────────────────────────────
// Listing scrapers
// ─────────────────────────────────────────────────────────

/**
 * Cào 1 trang listing → trả danh sách URL bài viết.
 *
 * Flatsome theme dùng `.col-inner > .box` với link đến article trong h5/h6.
 * Strategy đơn giản: lấy mọi anchor có href trỏ đến BASE_URL + ".html" + KHÔNG
 * thuộc các category/listing path → đó là article URLs.
 */
const scrapeCategoryPage = async (categoryPath, pageNum) => {
  const url = pageNum > 1
    ? `${BASE_URL}${categoryPath}/page/${pageNum}`
    : `${BASE_URL}${categoryPath}`;

  let html;
  try {
    html = await fetchHtml(url);
  } catch (e) {
    // Page > last page → WordPress trả 404. Đây là điều kiện dừng tự nhiên,
    // KHÔNG phải error thật. Trả empty để vòng lặp page dừng.
    if (/HTTP 404/.test(e.message)) return [];
    throw e;
  }

  const $ = cheerio.load(html);
  const seen = new Set();
  const urls = [];

  // Chỉ lấy link trong main content area để tránh menu/footer/sidebar
  const $main = $('#main, main, .page-wrapper, .row-main').first();
  const $scope = $main.length ? $main : $('body');

  $scope.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    if (!href.startsWith(BASE_URL)) return;
    if (!/\.html(\?.*)?(#.*)?$/i.test(href)) return;
    if (NON_ARTICLE_PATH_RE.test(href.slice(BASE_URL.length))) return;

    // Strip fragment/query để dedup chính xác hơn
    const clean = href.split('#')[0].split('?')[0];
    if (seen.has(clean)) return;
    seen.add(clean);
    urls.push(clean);
  });

  return urls;
};

/**
 * Cào nhiều trang của 1 category, return list URL bài viết (đã dedup).
 *
 * Dừng khi:
 *   - Page trả 404 (vượt last page)
 *   - Page trả 0 article URL mới (end of list)
 *   - Đạt maxPages
 */
const scrapeCategoryListing = async (categoryPath, maxPages = 5) => {
  const all = new Set();
  for (let p = 1; p <= maxPages; p++) {
    try {
      const urls = await scrapeCategoryPage(categoryPath, p);
      if (urls.length === 0) {
        console.log(`[soict scrape] ${categoryPath} page ${p}: empty, stopping`);
        break;
      }
      const before = all.size;
      urls.forEach((u) => all.add(u));
      if (all.size === before) {
        console.log(`[soict scrape] ${categoryPath} page ${p}: no new URLs, stopping`);
        break;
      }
      // Lịch sự với server: nghỉ giữa các page request
      if (p < maxPages) await sleep(DETAIL_DELAY_MS);
    } catch (e) {
      console.warn(`[soict scrape] page ${p} of ${categoryPath} fail: ${e.message}`);
      break;
    }
  }
  return [...all];
};

// ─────────────────────────────────────────────────────────
// Article detail scraper
// ─────────────────────────────────────────────────────────

/**
 * Cào trang chi tiết bài viết SoICT.
 *
 * Ưu tiên đọc Open Graph + article meta tags (rất sạch trên WordPress) trước
 * khi fallback sang DOM parsing.
 *
 * @returns { title, summary, files, imageUrl, publishedAt }
 */
export const scrapeArticle = async (url) => {
  const html = await fetchHtml(url);
  const $    = cheerio.load(html);

  // ── Bước 1: Meta tags (clean, reliable) ──
  // og:title thường có suffix " - SoICT" → strip
  const ogTitle = getMeta($, 'og:title');
  const ogDesc  = getMeta($, 'og:description');
  const ogImage = getMeta($, 'og:image');
  const pubRaw  = getMeta($, 'article:published_time');

  const title = (ogTitle || $('h1').first().text() || $('title').text())
    .replace(/\s*[-–|]\s*SoICT\s*$/i, '')
    .trim();

  let publishedAt = null;
  if (pubRaw) {
    const d = new Date(pubRaw);
    if (Number.isFinite(d.getTime())) publishedAt = d;
  }

  // ── Bước 2: Tìm body chứa content ──
  // Flatsome thường dùng .entry-content / .post-content; WordPress core dùng
  // .entry-content; một số custom dùng article > .content. Cứ thử lần lượt.
  const candidates = [
    '.entry-content',
    '.post-content',
    '.post-inside .content',
    'article .content',
    '.col.post-content',
    'main article',
    'article',
    'main',
  ];
  let $body = null;
  for (const sel of candidates) {
    const $found = $(sel);
    if ($found.length && $found.text().trim().length > 50) {
      $body = $found.first();
      break;
    }
  }
  if (!$body) $body = $('body');

  // ── Bước 3: Extract file links TRƯỚC khi strip ──
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
  // Ảnh lớn nhúng inline (heuristic: bỏ qua < 100x100, có thể là icon UI)
  $body.find('img[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src || !FILE_EXT_RE.test(src)) return;
    const abs = absUrl(src);
    if (!abs || seenUrls.has(abs)) return;
    const w = Number.parseInt($(el).attr('width'), 10);
    const h = Number.parseInt($(el).attr('height'), 10);
    if (Number.isFinite(w) && Number.isFinite(h) && w < 100 && h < 100) return;
    // Bỏ nếu là cùng ảnh với og:image (chỉ khác variant kích thước WordPress).
    // og:image đã được lưu riêng ở news.image_url → tránh duplicate trong attachments.
    if (ogImage && stripWpSizeSuffix(abs) === stripWpSizeSuffix(ogImage)) return;
    seenUrls.add(abs);
    files.push({ url: abs, name: fileNameFromUrl(abs, $(el).attr('alt')) });
  });

  // ── Bước 4: Strip + extract plain text ──
  $body.find(
    'script, style, header, nav, footer, ' +
    '.navigation, .breadcrumb, .menu, .sidebar, ' +
    '.social-icons, .share-icons, .post-share, .share-buttons, ' +
    '.related-posts, .related, .post-nav, .post-navigation, ' +
    '.widget, .author-box, .comments, #comments, ' +
    '.entry-meta, .post-meta',
  ).remove();

  let summary = normalizeText($body.text());
  // Fallback: nếu body extraction fail, dùng og:description (ngắn hơn nhưng còn hơn không)
  if (summary.length < 50 && ogDesc) summary = ogDesc;

  return {
    title:       title || '(không có tiêu đề)',
    summary,
    files,
    imageUrl:    ogImage,
    publishedAt,
  };
};

// ─────────────────────────────────────────────────────────
// DB sync
// ─────────────────────────────────────────────────────────

const getSourceId = async () => {
  const r = await query('SELECT id FROM news_sources WHERE name = $1', [SOURCE_NAME]);
  if (!r.rows[0]) {
    throw new Error(
      `news_sources không có row "${SOURCE_NAME}". Chạy migration 005 trước.`,
    );
  }
  return r.rows[0].id;
};

/** Upsert news, trả `{ newsId, status }`. Giống hệt CTT scraper. */
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

/** Download các file đính kèm. Resilient — fail 1 file không crash cả batch. */
const downloadNewsFiles = async (newsId, files) => {
  let downloaded = 0, failed = 0, skipped = 0;

  for (const f of files) {
    try {
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
      console.warn(`[soict scrape] file fail ${f.url}: ${e.message}`);
      failed++;
    }
  }
  return { downloaded, failed, skipped };
};

/**
 * Cào và sync. Resilient.
 *
 * @param {object} options
 * @param {boolean} options.refetchExisting Mặc định false: bỏ bài đã có summary đủ dài.
 * @param {number}  options.limit           Tối đa N bài mỗi lần (default 50).
 * @param {boolean} options.skipFiles       Bỏ download file (test/debug).
 * @param {number}  options.maxPages        Số page tối đa cào MỖI category (default 5).
 */
export const syncNews = async ({
  refetchExisting = false,
  limit = 50,
  skipFiles = false,
  maxPages = 5,
} = {}) => {
  const sourceId = await getSourceId();

  let created = 0, updated = 0, skipped = 0, failed = 0;
  let filesDownloaded = 0, filesFailed = 0;
  let totalProcessed = 0;

  for (const cat of CATEGORIES) {
    if (totalProcessed >= limit) break;
    const remaining = limit - totalProcessed;

    const urls = (await scrapeCategoryListing(cat.path, maxPages)).slice(0, remaining);
    console.log(
      `[soict scrape] ${cat.path} (kind=${cat.kind}): ${urls.length} URLs to process`,
    );

    for (const articleUrl of urls) {
      totalProcessed++;
      try {
        const existing = await query(
          'SELECT id, summary FROM news WHERE article_url = $1',
          [articleUrl],
        );
        const hasSummary = existing.rows[0]?.summary && existing.rows[0].summary.length > 100;
        if (hasSummary && !refetchExisting) { skipped++; continue; }

        let detail;
        try {
          detail = await scrapeArticle(articleUrl);
          await sleep(DETAIL_DELAY_MS);
        } catch (e) {
          console.warn(`[soict scrape] detail fail ${articleUrl}: ${e.message}`);
          failed++;
          continue;
        }

        const { newsId, status } = await upsertNews(sourceId, {
          kind:         cat.kind,
          title:        detail.title,
          summary:      detail.summary,
          url:          articleUrl,
          image_url:    detail.imageUrl,
          tag:          cat.tag,
          published_at: detail.publishedAt,
        });
        if (status === 'created') created++; else updated++;

        if (!skipFiles && detail.files && detail.files.length > 0) {
          const r = await downloadNewsFiles(newsId, detail.files);
          filesDownloaded += r.downloaded;
          filesFailed     += r.failed;
        }
      } catch (err) {
        console.error(`[soict scrape] upsert fail ${articleUrl}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(
    `[soict scrape] DONE total=${totalProcessed} created=${created} ` +
    `updated=${updated} skipped=${skipped} failed=${failed} ` +
    `files_downloaded=${filesDownloaded} files_failed=${filesFailed}`,
  );
  return {
    total: totalProcessed, created, updated, skipped, failed,
    files_downloaded: filesDownloaded, files_failed: filesFailed,
  };
};
