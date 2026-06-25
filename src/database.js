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
    await seedAgentesEAdmin();
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
    CREATE TABLE IF NOT EXISTS agentes (
      id SERIAL PRIMARY KEY, name VARCHAR(255),
      sector VARCHAR(50), status VARCHAR(20) DEFAULT 'IDLE',
      created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS missions (
      id SERIAL PRIMARY KEY, command TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      reasoning TEXT, result TEXT, source VARCHAR(50),
      created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rpa_queue (
      id SERIAL PRIMARY KEY, robot_id VARCHAR(50),
      type VARCHAR(100), input_data JSONB,
      status VARCHAR(20) DEFAULT 'pending',
      priority INT DEFAULT 5,
      retries INT DEFAULT 0, max_retries INT DEFAULT 3,
      error_log TEXT, result_data JSONB,
      tenant_uuid UUID,
      created_at TIMESTAMP DEFAULT NOW(),
      started_at TIMESTAMP, completed_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS rpa_logs (
      id SERIAL PRIMARY KEY, queue_id INT,
      robot_id VARCHAR(50), level VARCHAR(10) DEFAULT 'info',
      message TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  try {
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS company_name VARCHAR(255)`);
    await pool.query(`ALTER TABLE tenants ADD COLUMN IF NOT EXISTS role VARCHAR(50) DEFAULT 'user'`);
  } catch (e) { /* column may already exist */ }
  console.log('[DB] Schema verificado — RPA incluído');
}

export async function seedAgentesEAdmin() {
  if (!dbOk || !pool) return;
  try {
    await pool.query(`
      INSERT INTO tenants (company_name, email, status, role)
      VALUES ($1, $2, 'active', 'admin'), ($3, $4, 'active', 'admin')
      ON CONFLICT (email) DO UPDATE SET status = 'active', role = 'admin';
    `, ['Master Netizen', 'vpquintino@gmail.com', 'Armarinho da Jack', 'armarinhodajack@gmail.com']);
    const res = await pool.query("SELECT COUNT(*) AS cnt FROM agentes;");
    if (parseInt(res.rows[0].cnt) === 0) {
      console.log('[DB] Semeando os 8 Robôs Setoriais...');
      await pool.query(`
        INSERT INTO agentes (name, sector, status) VALUES
        ('Robô de Marketing', 'marketing', 'RUNNING'),
        ('Robô de CRM', 'crm', 'RUNNING'),
        ('Robô Financeiro', 'financeiro', 'RUNNING'),
        ('Robô de Contabilidade', 'contabilidade', 'RUNNING'),
        ('Robô Jurídico', 'juridico', 'RUNNING'),
        ('Robô de Logística', 'logistica', 'RUNNING'),
        ('Robô de RH', 'rh', 'RUNNING'),
        ('Robô de Helpdesk', 'helpdesk', 'RUNNING');
      `);
      console.log('[DB] Robôs semeados com sucesso!');
    }
  } catch (err) {
    console.error('[DB] Erro no seed:', err.message);
  }
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
