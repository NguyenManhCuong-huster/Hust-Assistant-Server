/**
 * newsRecommendationService.js — đề xuất news cho user dựa trên user_info.
 *
 * THUẬT TOÁN: keyword scoring có weight, không dùng AI model.
 *
 * Trọng số:
 *   student_id : 10  (exact MSSV → chắc chắn liên quan)
 *   class_name :  5  (lớp cụ thể, vd "CTTT01-K66")
 *   major_full :  4  (tên ngành đầy đủ)
 *   major_acro :  3  (viết tắt, vd CNTT)
 *   course     :  3  (K66, K67…)
 *   school     :  1  (low vì HUST CTT vốn đã là HUST)
 *
 * Boost multiplicative sau khi cộng:
 *   - News < 7  ngày → × 1.4
 *   - News < 30 ngày → × 1.2
 *   - Tag ĐTĐH/DTDH  → × 1.2
 *
 * Quy ước cache (lazy, TTL 6h):
 *  - getForUser()         : luôn trả từ news_recommendations + JOIN news.
 *  - ensureFresh()        : nếu cache trống HOẶC > 6h → recompute.
 *  - refreshForUser()     : luôn recompute (kể cả cache còn fresh).
 *  - invalidateForUser()  : xoá toàn bộ rows của user (gọi khi user update profile).
 *
 * Khi nào gọi?
 *  - GET  /api/news/recommendations          → ensureFresh() rồi getForUser()
 *  - POST /api/news/recommendations/refresh  → refreshForUser()
 *  - userInfo PUT/PATCH/POST                 → invalidateForUser() (next request sẽ recompute)
 */

import { query, getClient } from '../config/db.js';

// ─── Config ──────────────────────────────────────────────────
const CACHE_TTL_MS        = 6 * 60 * 60 * 1000;   // 6 hours
const SCORE_THRESHOLD     = 3.0;                  // Loại news có score < 3
const MAX_RECOMMENDATIONS = 50;                   // Top N giữ lại trong cache
const CANDIDATE_LIMIT     = 500;                  // Chỉ score 500 news mới nhất

const WEIGHTS = {
  student_id:    10.0,
  class_name:     5.0,
  major_full:     4.0,
  major_acronym:  3.0,
  course:         3.0,
  school:         1.0,
};

const TAG_BOOSTS = {
  'ĐTĐH': 1.2,
  'DTDH': 1.2,
};

// ─── Helpers ─────────────────────────────────────────────────

/** Sinh viết tắt: "Công nghệ thông tin" → "CNTT". */
const makeAcronym = (s) => {
  if (!s) return '';
  return s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0])
    .join('')
    .toUpperCase();
};

/** Substring match case-insensitive. */
const contains = (haystack, needle) =>
  needle && haystack.toLowerCase().includes(needle.toLowerCase());

/** Build reason text từ list keyword đã match (top 3). */
const buildReason = (matched) => {
  if (matched.length === 0) return null;
  return 'Khớp: ' + matched.slice(0, 3).join(', ');
};

/** Multiplier theo độ mới của news. */
const recencyBoost = (publishedAt) => {
  if (!publishedAt) return 1.0;
  const ageMs = Date.now() - new Date(publishedAt).getTime();
  const days  = ageMs / (24 * 60 * 60 * 1000);
  if (days <= 7)  return 1.4;
  if (days <= 30) return 1.2;
  return 1.0;
};

// ─── Core scoring ────────────────────────────────────────────

/**
 * Tính điểm 1 news cho 1 userInfo.
 * @returns { score: number, matched: string[] } — score=0 nếu không match keyword nào.
 */
const scoreNews = (news, userInfo) => {
  const text = `${news.title || ''} ${news.summary || ''}`;
  let   score   = 0;
  const matched = [];

  // 1. student_id (exact, weight cao nhất)
  if (contains(text, userInfo.student_id)) {
    score += WEIGHTS.student_id;
    matched.push(userInfo.student_id);
  }

  // 2. class_name (vd "CTTT01-K66")
  if (contains(text, userInfo.class_name)) {
    score += WEIGHTS.class_name;
    matched.push(userInfo.class_name);
  }

  // 3. major (full text + acronym, mỗi cái 1 weight riêng)
  if (contains(text, userInfo.major)) {
    score += WEIGHTS.major_full;
    matched.push(userInfo.major);
  }
  const acronym = makeAcronym(userInfo.major);
  if (acronym.length >= 2 && contains(text, acronym)) {
    score += WEIGHTS.major_acronym;
    if (!matched.includes(acronym)) matched.push(acronym);
  }

  // 4. course (K66, K67...)
  if (contains(text, userInfo.course)) {
    score += WEIGHTS.course;
    matched.push(userInfo.course);
  }

  // 5. school (low weight — HUST CTT vốn đã là HUST)
  if (contains(text, userInfo.school)) {
    score += WEIGHTS.school;
    // Không add vào matched để reason không bị spam
  }

  // Boost
  const tagMul = TAG_BOOSTS[news.tag] ?? 1.0;
  const recMul = recencyBoost(news.published_at);

  return {
    score: score * tagMul * recMul,
    matched,
  };
};

// ─── DB operations ───────────────────────────────────────────

const fetchUserInfo = async (userId) => {
  const r = await query(
    `SELECT student_id, full_name, school, major, class_name, course
     FROM user_info WHERE user_id = $1`,
    [userId],
  );
  return r.rows[0] ?? null;
};

const fetchCandidateNews = async () => {
  const r = await query(
    `SELECT id, title, summary, tag, kind, published_at
     FROM news
     WHERE is_deleted = FALSE
       AND (title IS NOT NULL OR summary IS NOT NULL)
     ORDER BY published_at DESC NULLS LAST
     LIMIT $1`,
    [CANDIDATE_LIMIT],
  );
  return r.rows;
};

/** Xoá toàn bộ recommendation cũ của user, insert lại batch mới (atomic). */
const replaceCache = async (userId, recommendations) => {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      'DELETE FROM news_recommendations WHERE user_id = $1',
      [userId],
    );
    if (recommendations.length > 0) {
      const values       = [];
      const placeholders = [];
      let   i            = 1;
      for (const rec of recommendations) {
        placeholders.push(`($${i++}, $${i++}, $${i++}, $${i++}, $${i++})`);
        values.push(
          userId,
          rec.news_id,
          rec.score,
          rec.reason,
          rec.matched_keywords,
        );
      }
      await client.query(
        `INSERT INTO news_recommendations
           (user_id, news_id, score, reason, matched_keywords)
         VALUES ${placeholders.join(',')}`,
        values,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
};

// ─── Public API ──────────────────────────────────────────────

/**
 * Recompute recommendations cho user, GHI ĐÈ cache cũ.
 * No-op (clear cache) nếu user chưa setup user_info.
 */
export const refreshForUser = async (userId) => {
  const userInfo = await fetchUserInfo(userId);
  if (!userInfo) {
    await query('DELETE FROM news_recommendations WHERE user_id = $1', [userId]);
    return { computed: 0, kept: 0, reason: 'no_user_info' };
  }

  const candidates = await fetchCandidateNews();
  const scored     = [];

  for (const news of candidates) {
    const { score, matched } = scoreNews(news, userInfo);
    if (score >= SCORE_THRESHOLD) {
      scored.push({
        news_id:          news.id,
        score,
        reason:           buildReason(matched),
        matched_keywords: matched,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, MAX_RECOMMENDATIONS);

  await replaceCache(userId, top);
  return { computed: candidates.length, kept: top.length };
};

/**
 * Đảm bảo cache còn fresh (< 6h). Nếu stale/empty → recompute.
 * @returns true nếu vừa recompute, false nếu cache còn dùng được.
 */
export const ensureFresh = async (userId) => {
  const r = await query(
    `SELECT MAX(generated_at) AS latest
     FROM news_recommendations WHERE user_id = $1`,
    [userId],
  );
  const latest = r.rows[0]?.latest;
  if (!latest) {
    await refreshForUser(userId);
    return true;
  }
  const ageMs = Date.now() - new Date(latest).getTime();
  if (ageMs > CACHE_TTL_MS) {
    await refreshForUser(userId);
    return true;
  }
  return false;
};

/**
 * Lấy recommendations đã cache (JOIN với news để trả full data).
 */
export const getForUser = async (userId, { limit = 50, includeDismissed = false } = {}) => {
  const dismissCond = includeDismissed ? '' : 'AND r.is_dismissed = FALSE';
  const r = await query(
    `SELECT n.id, n.kind, n.title, n.summary, n.article_url, n.image_url, n.tag,
            n.published_at, n.mod_time,
            s.name AS source_name,
            r.score, r.reason, r.matched_keywords, r.generated_at, r.is_dismissed
     FROM news_recommendations r
     JOIN news n ON n.id = r.news_id AND n.is_deleted = FALSE
     LEFT JOIN news_sources s ON s.id = n.source_id
     WHERE r.user_id = $1 ${dismissCond}
     ORDER BY r.score DESC, n.published_at DESC NULLS LAST
     LIMIT $2`,
    [userId, limit],
  );
  return r.rows;
};

/** User dismiss 1 recommendation (không hiện lại). */
export const dismissForUser = async (userId, newsId) => {
  const r = await query(
    `UPDATE news_recommendations
       SET is_dismissed = TRUE
     WHERE user_id = $1 AND news_id = $2
     RETURNING news_id`,
    [userId, newsId],
  );
  return r.rows[0] != null;
};

/** Xoá toàn bộ cache của user (gọi khi user update profile). */
export const invalidateForUser = async (userId) => {
  await query('DELETE FROM news_recommendations WHERE user_id = $1', [userId]);
};
