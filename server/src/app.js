import express      from 'express';
import cors         from 'cors';
import cookieParser from 'cookie-parser';
import session      from 'express-session';

import passport               from './config/passport.js';
import authRoutes             from './routes/auth.js';
import accountRoutes          from './routes/accounts.js';
import taskRoutes             from './routes/tasks.js';
import tagRoutes              from './routes/tags.js';
import syncRoutes             from './routes/sync.js';
import userInfoRoutes         from './routes/userInfo.js';
import emailRoutes            from './routes/emails.js';
import aiRoutes               from './routes/ai.js';
import newsRoutes             from './routes/news.js';
import attachmentRoutes       from './routes/attachments.js';                  // ← MỚI
import { startPolling }       from './services/emailSyncService.js';
import { startNewsScheduler } from './services/newsScrapeScheduler.js';

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
app.use('/api/sync',        syncRoutes);
app.use('/api/user-info',   userInfoRoutes);
app.use('/api/emails',      emailRoutes);
app.use('/api/ai',          aiRoutes);
app.use('/api/news',        newsRoutes);
app.use('/api/attachments', attachmentRoutes);                                 // ← MỚI

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
  console.error('[Error]', err);
  res.status(500).json({
    success: false,
    message: 'Lỗi server nội bộ.',
    ...(process.env.NODE_ENV === 'development' && { error: err.message }),
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
