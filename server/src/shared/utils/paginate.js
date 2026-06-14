export const parsePagination = (queryParams, { defaultLimit = 20, maxLimit = 100 } = {}) => {
  const page   = Math.max(1, Number.parseInt(queryParams.page, 10)  || 1);
  const limit  = Math.min(maxLimit, Math.max(1, Number.parseInt(queryParams.limit, 10) || defaultLimit));
  const offset = (page - 1) * limit;
  return { page, limit, offset };
};

export const buildPageMeta = (total, page, limit) => {
  const totalPage = Math.ceil(total / limit);
  return { total, page, limit, total_page: totalPage, has_next: page < totalPage };
};
