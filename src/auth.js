import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { query, isDBReady } from './database.js';

const JWT_SECRET = process.env.JWT_SECRET || 'athena_ia_jwt_secret_2024_hyperautomation';
const JWT_EXPIRES = '7d';

// ===== Contas Master Fixas (bypass irrestrito) =====
const MASTERS = [
  { email: 'vpquintino@gmail.com',     password: '@Blt18023', name: 'Victor Quintino',   role: 'master' },
  { email: 'armarinhodajack@gmail.com', password: '@126373@',  name: 'Armarinho da Jack', role: 'master' },
];

// ===== Usuários em memória (fallback) =====
let memUsers = [];
let userIdCounter = 0;
const MASTER_UUID_MEM = '00000000-0000-0000-0000-000000000001';

// ===== Helpers =====
function isMaster(email, password) {
  return MASTERS.find(m => m.email === email && m.password === password);
}

function generateToken(payload) {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
}

export function verifyToken(token) {
  try { return jwt.verify(token, JWT_SECRET); }
  catch { return null; }
}

// ===== Garantir tabelas no DB =====
export async function ensureAuthSchema() {
  if (!isDBReady()) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        tenant_uuid UUID DEFAULT gen_random_uuid(),
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        name VARCHAR(255),
        role VARCHAR(20) DEFAULT 'user',
        plan_status VARCHAR(20) DEFAULT 'pending',
        plan_expires_at TIMESTAMP,
        cpf_cnpj VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS tenant_branding (
        id SERIAL PRIMARY KEY,
        tenant_uuid UUID UNIQUE,
        company_name VARCHAR(255),
        primary_color VARCHAR(7) DEFAULT '#7c3aed',
        secondary_color VARCHAR(7) DEFAULT '#3b82f6',
        logo_url VARCHAR(500),
        cpf_cnpj VARCHAR(20),
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
    `);
    // Seed masters if not exist
    for (const m of MASTERS) {
      const existing = await query('SELECT id FROM users WHERE email=$1', [m.email]);
      if (!existing || !existing.length) {
        const hash = await bcrypt.hash(m.password, 10);
        await query(
          `INSERT INTO users (email, password_hash, name, role, plan_status, tenant_uuid)
           VALUES($1,$2,$3,'master','active',gen_random_uuid()) ON CONFLICT (email) DO NOTHING`,
          [m.email, hash, m.name]
        );
      }
    }
    console.log('[AUTH] Schema verificado');
  } catch (e) {
    console.warn('[AUTH] Schema error:', e.message);
  }
}

// ===== Registrar usuário comum =====
export async function registerUser(email, password, name) {
  // Check se é master (não pode registrar, já existem)
  if (MASTERS.find(m => m.email === email)) {
    return { error: 'Conta master já registrada' };
  }

  const hash = await bcrypt.hash(password, 10);

  if (isDBReady()) {
    const existing = await query('SELECT id FROM users WHERE email=$1', [email]);
    if (existing && existing.length) return { error: 'Email já cadastrado' };

    const rows = await query(
      `INSERT INTO users (email, password_hash, name, role, plan_status)
       VALUES($1,$2,$3,'user','pending') RETURNING id, tenant_uuid, email, name, role, plan_status, created_at`,
      [email, hash, name || email.split('@')[0]]
    );
    if (rows && rows.length) {
      const user = rows[0];
      const token = generateToken({ id: user.id, email: user.email, tenant_uuid: user.tenant_uuid, role: 'user' });
      return { token, user };
    }
  }

  // Fallback memória
  const existing = memUsers.find(u => u.email === email);
  if (existing) return { error: 'Email já cadastrado' };

  const user = {
    id: ++userIdCounter,
    tenant_uuid: crypto.randomUUID ? crypto.randomUUID() : 'mem-' + userIdCounter,
    email, name: name || email.split('@')[0],
    role: 'user', plan_status: 'pending',
    created_at: new Date().toISOString(),
  };
  memUsers.push(user);
  const token = generateToken({ id: user.id, email: user.email, tenant_uuid: user.tenant_uuid, role: 'user' });
  return { token, user };
}

// ===== Login =====
export async function loginUser(email, password) {
  // Master bypass
  const master = isMaster(email, password);
  if (master) {
    let user;
    if (isDBReady()) {
      const rows = await query('SELECT * FROM users WHERE email=$1', [email]);
      if (rows && rows.length) user = rows[0];
    }
    if (!user) {
      user = { id: 0, tenant_uuid: MASTER_UUID_MEM, email: master.email, name: master.name, role: 'master', plan_status: 'active' };
    }
    const token = generateToken({ id: user.id, email: user.email, tenant_uuid: user.tenant_uuid, role: 'master' });
    return { token, user: { ...user, plan_status: 'active' }, master: true };
  }

  // Usuário comum
  if (isDBReady()) {
    const rows = await query('SELECT * FROM users WHERE email=$1', [email]);
    if (!rows || !rows.length) return { error: 'Credenciais inválidas' };
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) return { error: 'Credenciais inválidas' };
    const token = generateToken({ id: user.id, email: user.email, tenant_uuid: user.tenant_uuid, role: user.role });
    return { token, user: { ...user, password_hash: undefined } };
  }

  // Fallback memória
  const user = memUsers.find(u => u.email === email);
  if (!user) return { error: 'Credenciais inválidas' };
  const token = generateToken({ id: user.id, email: user.email, tenant_uuid: user.tenant_uuid, role: user.role });
  return { token, user };
}

// ===== Middlewares =====
export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header) return res.status(401).json({ error: 'Token não fornecido' });

  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  const decoded = verifyToken(token);
  if (!decoded) return res.status(401).json({ error: 'Token inválido ou expirado' });

  req.user = decoded;
  next();
}

export function optionalAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) { req.user = null; return next(); }
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  req.user = verifyToken(token);
  next();
}

export function masterOnly(req, res, next) {
  if (!req.user || req.user.role !== 'master') {
    return res.status(403).json({ error: 'Acesso restrito a administradores' });
  }
  next();
}

export function subscriptionRequired(req, res, next) {
  // Masters bypass
  if (req.user && req.user.role === 'master') return next();

  // Verificar plano ativo
  const checkPlan = async () => {
    if (isDBReady()) {
      const rows = await query('SELECT plan_status FROM users WHERE tenant_uuid=$1', [req.user.tenant_uuid]);
      if (rows && rows.length && rows[0].plan_status === 'active') return next();
    } else {
      const user = memUsers.find(u => u.tenant_uuid === req.user.tenant_uuid);
      if (user && user.plan_status === 'active') return next();
    }
    res.status(403).json({
      error: 'Assinatura necessária',
      code: 'SUBSCRIPTION_REQUIRED',
      message: 'Seu plano está inativo. Assine por R$ 350,00/mês para continuar usando.',
    });
  };
  checkPlan();
}

export function tenantIsolation(req, res, next) {
  // Masters veem tudo
  if (req.user && req.user.role === 'master') {
    req.tenantFilter = ''; // sem filtro
    return next();
  }

  // Usuários comuns só veem seus próprios dados
  const uuid = req.user?.tenant_uuid;
  if (!uuid) return res.status(401).json({ error: 'Tenant não identificado' });

  req.tenant_uuid = uuid;
  req.tenantFilter = uuid;
  next();
}

// ===== Rotas Express =====
export function mountAuthRoutes(app) {
  // POST /api/auth/register
  app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
    if (password.length < 6) return res.status(400).json({ error: 'Senha deve ter no mínimo 6 caracteres' });
    const result = await registerUser(email, password, name);
    if (result.error) return res.status(400).json(result);
    res.json(result);
  });

  // POST /api/auth/login
  app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email e senha obrigatórios' });
    const result = await loginUser(email, password);
    if (result.error) return res.status(401).json(result);
    res.json(result);
  });

  // GET /api/auth/me
  app.get('/api/auth/me', authMiddleware, async (req, res) => {
    const isMasterUser = req.user.role === 'master';
    res.json({
      id: req.user.id,
      email: req.user.email,
      tenant_uuid: req.user.tenant_uuid,
      role: req.user.role,
      isMaster: isMasterUser,
      plan_active: isMasterUser || true, // será verificado depois
    });
  });

  // GET /api/admin/users — Master apenas
  app.get('/api/admin/users', authMiddleware, masterOnly, async (req, res) => {
    if (isDBReady()) {
      const rows = await query('SELECT id, email, name, role, plan_status, tenant_uuid, created_at FROM users ORDER BY created_at DESC');
      return res.json(rows || []);
    }
    res.json(memUsers);
  });

  // PATCH /api/admin/users/:id/plan — Master ativa plano de usuário
  app.patch('/api/admin/users/:id/plan', authMiddleware, masterOnly, async (req, res) => {
    const { plan_status } = req.body;
    if (!plan_status) return res.status(400).json({ error: 'Status do plano obrigatório' });
    if (isDBReady()) {
      const rows = await query('UPDATE users SET plan_status=$1,plan_expires_at=NOW()+INTERVAL \'30 days\' WHERE id=$2 RETURNING *', [plan_status, req.params.id]);
      return res.json(rows?.[0] || { error: 'Usuário não encontrado' });
    }
    const user = memUsers.find(u => u.id === parseInt(req.params.id));
    if (user) user.plan_status = plan_status;
    res.json(user || { error: 'Usuário não encontrado' });
  });

  // GET /api/admin/stats — Dashboard administrativo
  app.get('/api/admin/stats', authMiddleware, masterOnly, async (req, res) => {
    let totalUsers = 0, activePlans = 0, pendingPlans = 0;
    if (isDBReady()) {
      const users = await query('SELECT plan_status FROM users');
      if (users) {
        totalUsers = users.length;
        activePlans = users.filter(u => u.plan_status === 'active').length;
        pendingPlans = users.filter(u => u.plan_status === 'pending').length;
      }
    } else {
      totalUsers = memUsers.length;
      activePlans = memUsers.filter(u => u.plan_status === 'active').length;
      pendingPlans = memUsers.filter(u => u.plan_status === 'pending').length;
    }
    res.json({ totalUsers, activePlans, pendingPlans, masters: MASTERS.map(m => m.email) });
  });
}
