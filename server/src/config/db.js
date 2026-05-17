import pg from 'pg';

const { Pool } = pg;

export const pool = new Pool({
  host:                     process.env.DB_HOST     ?? 'localhost',
  port:     Number.parseInt(process.env.DB_PORT, 10) || 5432,
  database:                 process.env.DB_NAME     ?? 'notification_aggregator',
  user:                     process.env.DB_USER     ?? 'admin',
  password:                 process.env.DB_PASSWORD ?? 'mysecretpassword',
  max:                      20,
  idleTimeoutMillis:        30_000,
  connectionTimeoutMillis:  2_000,
});

pool.on('connect', () => console.log('[DB] Connected to PostgreSQL'));
pool.on('error', (err) => {
  console.error('[DB] Unexpected error:', err);
  process.exit(-1);
});

export const query     = (text, params) => pool.query(text, params);
export const getClient = () => pool.connect();
