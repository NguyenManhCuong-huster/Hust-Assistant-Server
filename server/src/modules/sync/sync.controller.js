import * as svc from './sync.service.js';

export const pullSync = async (req, res, next) => {
  try {
    const { since } = req.query;
    if (!since) {
      return res.status(400).json({ success: false, message: '"since" là bắt buộc. Dùng ISO 8601.' });
    }
    const sinceDate = new Date(since);
    if (Number.isNaN(sinceDate.getTime())) {
      return res.status(400).json({ success: false, message: '"since" không hợp lệ.' });
    }

    const server_time = await svc.getServerTime();
    const changes     = await svc.pullChanges(req.user.id, sinceDate);

    res.json({
      success: true,
      server_time,
      changes,
      meta: { task_count: changes.tasks.length, tag_count: changes.tags.length },
    });
  } catch (err) { next(err); }
};

export const pushSync = async (req, res, next) => {
  try {
    const { tasks = [], tags = [] } = req.body;
    if (!Array.isArray(tasks) || !Array.isArray(tags)) {
      return res.status(400).json({ success: false, message: 'tasks, tags phải là array.' });
    }

    const server_time = await svc.getServerTime();
    const { taskResults, tagResults } =
      await svc.pushChanges(req.user.id, { tasks, tags });

    const allResults = [...taskResults, ...tagResults];
    res.json({
      success: true,
      server_time,
      results: { tasks: taskResults, tags: tagResults },
      meta: {
        tasks_processed: tasks.length,
        tags_processed:  tags.length,
        // "stale" = client cũ hơn/bằng server (server thắng) → client cần pull.
        stale:           allResults.filter((r) => r.status === 'stale').length,
      },
    });
  } catch (err) { next(err); }
};
