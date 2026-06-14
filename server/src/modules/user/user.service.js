import * as repo from '../../dao/user.dao.js';

export const getUserInfo   = (userId)       => repo.getUserInfo(userId);
export const checkExists   = (userId)       => repo.checkExists(userId);
export const deleteUserInfo = async (userId) => {
  const row = await repo.deleteUserInfo(userId);
  if (row) scheduleInvalidate(userId);
  return row;
};

export const createUserInfo = async (userId, data) => {
  const row = await repo.insertUserInfo(userId, data);
  scheduleInvalidate(userId);
  return row;
};

export const upsertUserInfo = async (userId, data) => {
  const row = await repo.upsertUserInfo(userId, data);
  scheduleInvalidate(userId);
  return row;
};

export const patchUserInfo = async (userId, data) => {
  const keys = Object.keys(data);
  const row  = await repo.patchUserInfo(userId, keys, keys.map((k) => data[k]));
  scheduleInvalidate(userId);
  return row;
};

// Fire-and-forget: invalidate news recommendations when profile changes.
const scheduleInvalidate = (userId) => {
  import('../news/news.service.js')
    .then((rec) => rec.invalidateForUser(userId))
    .catch((e) => console.error('[NewsRec] invalidate fail:', e.message));
};
