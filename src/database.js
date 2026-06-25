import pg from 'pg';
import dotenv from 'dotenv';
dotenv.config();

let pool = null;
let dbOk = false;
let retries = 0;
const MAX_RETRIES = 10;
const listeners = [];

export function onDBChange(fn) { listeners.push(fn); }
function notify() { listeners.forEach(f => f(dbOk)); }

export function isDBReady() { return dbOk; }
export function getPool() { return pool; }

export async function initDB() {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] DATABASE_URL não definida — operando em memória');
    notify();
    return;
  }
  try {
    if (pool) await pool.end().catch(() => {});
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });
    pool.on('error', err => {
      console.error('[DB] Pool error:', err.message);
      if (dbOk) { dbOk = false; notify(); reconnect(); }
    });
    await pool.query('SELECT 1');
    dbOk = true;
    retries = 0;
    console.log('[DB] PostgreSQL conectado');
    await createSchema();
    notify();
  } catch (e) {
    console.warn('[DB] Falha na conexão:', e.message);
    dbOk = false;
    notify();
    reconnect();
  }
}

async function reconnect() {
  if (retries >= MAX_RETRIES) {
    console.error('[DB] Máximo de tentativas');
    return;
  }
  retries++;
  const delay = Math.min(1000 * 2 ** retries, 30000);
  console.log(`[DB] Reconectando em ${delay}ms (${retries}/${MAX_RETRIES})`);
  await new Promise(r => setTimeout(r, delay));
  await initDB();
}

async function createSchema() {
  if (!dbOk || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY, uuid UUID DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE, name VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      plan_type VARCHAR(50) DEFAULT 'monthly',
      plan_price DECIMAL(10,2) DEFAULT 0,
      payment_id VARCHAR(100), payment_status VARCHAR(30),
      created_at TIMESTAMP DEFAULT NOW(),
      activated_at TIMESTAMP, expires_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS agents_log (
      id SERIAL PRIMARY KEY, agent VARCHAR(50),
      sector VARCHAR(50), action TEXT,
      input TEXT, output TEXT, status VARCHAR(20),
      source VARCHAR(50), created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS social_messages (
      id SERIAL PRIMARY KEY, platform VARCHAR(30),
      from_id VARCHAR(100), from_name VARCHAR(255),
      message TEXT, direction VARCHAR(10),
      agent VARCHAR(50), response TEXT,
      processed BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS oauth2_tokens (
      id SERIAL PRIMARY KEY, platform VARCHAR(30),
      access_token TEXT, refresh_token TEXT,
      expires_at TIMESTAMP, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tasks_queue (
      id SERIAL PRIMARY KEY, agent VARCHAR(50),
      input TEXT, status VARCHAR(20) DEFAULT 'pending',
      retries INT DEFAULT 0, result TEXT,
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS missions (
      id SERIAL PRIMARY KEY, command TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      reasoning TEXT, result TEXT, source VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
    );
  `);
  console.log('[DB] Schema verificado');
}

export async function query(text, params) {
  if (dbOk && pool) try {
    const r = await pool.query(text, params);
    return r.rows;
  } catch (e) { /* fallback */ }
  return null;
}

export async function healthCheck() {
  if (!pool || !dbOk) return false;
  try { await pool.query('SELECT 1'); return true; }
  catch { dbOk = false; notify(); reconnect(); return false; }
}
