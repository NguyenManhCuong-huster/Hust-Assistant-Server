import express      from 'express';
import cors         from 'cors';
import cookieParser from 'cookie-parser';
import session      from 'express-session';

import passport           from './infrastructure/passport.js';
import authRoutes         from './modules/auth/auth.routes.js';
import accountRoutes      from './modules/accounts/accounts.routes.js';
import taskRoutes         from './modules/tasks/tasks.routes.js';
import tagRoutes          from './modules/tags/tags.routes.js';
import gradeRoutes        from './modules/grades/grades.routes.js';
import syncRoutes         from './modules/sync/sync.routes.js';
import userInfoRoutes     from './modules/user/user.routes.js';
import emailRoutes        from './modules/emails/emails.routes.js';
import aiRoutes           from './modules/ai/ai.routes.js';
import newsRoutes         from './modules/news/news.routes.js';
import attachmentRoutes   from './modules/attachments/attachments.routes.js';
import { startPolling }       from './modules/emails/emails.service.js';
import { startNewsScheduler } from './modules/news/news.scheduler.js';

const app  = express();
const PORT = Number.parseInt(process.env.PORT, 10) || 3000;

app.use(cors({
  origin:      process.env.FRONTEND_URL ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use(session({
  secret:            process.env.SESSION_SECRET ?? 'fallback_secret',
  resave:            false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    maxAge: 5 * 60 * 1000,
  },
}));
app.use(passport.initialize());
app.use(passport.session());

app.use('/api/auth',        authRoutes);
app.use('/api/accounts',    accountRoutes);
app.use('/api/tasks',       taskRoutes);
app.use('/api/tags',        tagRoutes);
app.use('/api/grades',      gradeRoutes);
app.use('/api/sync',        syncRoutes);
app.use('/api/user-info',   userInfoRoutes);
app.use('/api/emails',      emailRoutes);
app.use('/api/ai',          aiRoutes);
app.use('/api/news',        newsRoutes);
app.use('/api/attachments', attachmentRoutes);

app.get('/api/health', (_req, res) => {
  res.json({
    success:   true,
    message:   'Server đang chạy bình thường',
    timestamp: new Date().toISOString(),
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, message: `Route ${req.path} không tồn tại.` });
});

app.use((err, _req, res, _next) => {
  const status = err.statusCode ?? 500;
  if (status >= 500) console.error('[Error]', err);
  res.status(status).json({
    success: false,
    message: err.message || 'Lỗi server nội bộ.',
    ...(process.env.NODE_ENV === 'development' && status >= 500 && { stack: err.stack }),
  });
});

app.listen(PORT, () => {
  console.log(`🚀 Server: http://localhost:${PORT}`);

  if (process.env.ENABLE_EMAIL_POLLING === 'true') {
    const intervalMs = Number.parseInt(process.env.POLL_INTERVAL_MS, 10) || 5 * 60 * 1000;
    startPolling(intervalMs);
  }

  startNewsScheduler();
});

export default app;
