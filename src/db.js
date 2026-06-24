import pkg from "pg";
import crypto from "crypto";

const { Pool } = pkg;

let pool = null;
let fallbackMode = false;
const fallbackUsers = new Map();

const MASTERS = [
  { id: "00000000-0000-0000-0000-000000000000", email: "vpquintino@gmail.com", password: "@Blt18023", tipo_usuario: "master", plano_status: "ativo", criado_em: new Date().toISOString() },
  { id: "00000000-0000-0000-0000-000000000001", email: "armarinhodajack@gmail.com", password: "@126373@", tipo_usuario: "master", plano_status: "ativo", criado_em: new Date().toISOString() },
];
function findMaster(email) { return MASTERS.find(m => m.email === email.toLowerCase().trim()); }

function initPool() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set — using in-memory fallback");
    fallbackMode = true;
    MASTERS.forEach(m => { if (!fallbackUsers.has(m.email)) fallbackUsers.set(m.email, { ...m }); });
    return;
  }

  try {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
    });

    pool.on("error", (err) => {
      console.error("PostgreSQL pool error:", err.message);
      console.log("Switching to in-memory fallback...");
      fallbackMode = true;
      pool = null;
      MASTERS.forEach(m => { if (!fallbackUsers.has(m.email)) fallbackUsers.set(m.email, { ...m }); });
    });
  } catch (err) {
    console.log("PostgreSQL init failed:", err.message, "- using fallback");
    fallbackMode = true;
    MASTERS.forEach(m => { if (!fallbackUsers.has(m.email)) fallbackUsers.set(m.email, { ...m }); });
  }
}

function getPool() {
  if (!pool && !fallbackMode) initPool();
  return { pool, fallbackMode, fallbackUsers, MASTERS, findMaster };
}

export async function query(text, params) {
  const { pool: p, fallbackMode: fb } = getPool();
  if (fb || !p) throw new Error("PostgreSQL not available — using fallback");
  return p.query(text, params);
}

export async function findUserById(id) {
  const { pool: p, fallbackMode: fb, fallbackUsers: fbUsers } = getPool();
  if (fb || !p) {
    for (const u of fbUsers.values()) {
      if (u.id === id) return u;
    }
    return null;
  }
  try {
    const result = await p.query("SELECT * FROM usuarios WHERE id = $1", [id]);
    return result.rows[0] || null;
  } catch {
    for (const u of fbUsers.values()) {
      if (u.id === id) return u;
    }
    return null;
  }
}

export async function findUserByEmail(email) {
  const { pool: p, fallbackMode: fb, fallbackUsers: fbUsers, findMaster: fm } = getPool();
  const normalized = email.toLowerCase().trim();

  const master = fm(normalized);
  if (master) return { ...master, id: master.id };

  if (fb || !p) {
    return fbUsers.get(normalized) || null;
  }

  try {
    const result = await p.query("SELECT * FROM usuarios WHERE LOWER(email) = $1", [normalized]);
    return result.rows[0] || null;
  } catch {
    return fbUsers.get(normalized) || null;
  }
}

export async function createUser(email, hashedPassword, tipo_usuario = "cliente") {
  const { pool: p, fallbackMode: fb, fallbackUsers: fbUsers, findMaster: fm } = getPool();
  const normalized = email.toLowerCase().trim();

  if (fm(normalized)) throw new Error("Email reservado");

  const id = crypto.randomUUID();
  const criado_em = new Date().toISOString();

  if (fb || !p) {
    if (fbUsers.has(normalized)) throw new Error("Usuário já cadastrado");
    fbUsers.set(normalized, { id, email: normalized, password: hashedPassword, tipo_usuario, plano_status: "ativo", criado_em });
    return { id, email: normalized, tipo_usuario, plano_status: "ativo" };
  }

  try {
    const result = await p.query(
      `INSERT INTO usuarios (id, email, password, tipo_usuario, plano_status, criado_em)
       VALUES ($1, $2, $3, $4, 'ativo', $5)
       RETURNING id, email, tipo_usuario, plano_status, criado_em`,
      [id, normalized, hashedPassword, tipo_usuario, criado_em]
    );
    return result.rows[0];
  } catch (err) {
    if (err.code === "23505") throw new Error("Usuário já cadastrado");
    throw err;
  }
}

export async function listAllUsers() {
  const { pool: p, fallbackMode: fb, fallbackUsers: fbUsers, MASTERS: masters } = getPool();
  if (fb || !p) {
    const all = [];
    for (const u of fbUsers.values()) all.push(u);
    for (const m of masters) {
      if (!all.some(x => x.email === m.email)) all.push(m);
    }
    return all;
  }
  try {
    const result = await p.query("SELECT id, email, tipo_usuario, plano_status, criado_em FROM usuarios ORDER BY criado_em DESC");
    return result.rows;
  } catch {
    const all = [];
    for (const u of fbUsers.values()) all.push(u);
    for (const m of masters) {
      if (!all.some(x => x.email === m.email)) all.push(m);
    }
    return all;
  }
}

export async function updateUserPlan(userId, status) {
  const { pool: p, fallbackMode: fb, fallbackUsers: fbUsers } = getPool();
  if (fb || !p) {
    for (const u of fbUsers.values()) {
      if (u.id === userId) { u.plano_status = status; return { id: u.id, email: u.email, plano_status: u.plano_status }; }
    }
    return null;
  }
  try {
    const result = await p.query(
      "UPDATE usuarios SET plano_status = $1 WHERE id = $2 RETURNING id, email, plano_status",
      [status, userId]
    );
    return result.rows[0] || null;
  } catch {
    for (const u of fbUsers.values()) {
      if (u.id === userId) { u.plano_status = status; return { id: u.id, email: u.email, plano_status: u.plano_status }; }
    }
    return null;
  }
}

export async function seedMaster() {
  const { pool: p, fallbackMode: fb, MASTERS: masters } = getPool();
  if (fb || !p) return;

  try {
    const bcrypt = await import("bcrypt");
    for (const m of masters) {
      const exists = await p.query("SELECT id FROM usuarios WHERE email = $1", [m.email]);
      if (exists.rows.length === 0) {
        const hash = await bcrypt.hash(m.password, 10);
        await p.query(
          `INSERT INTO usuarios (id, email, password, tipo_usuario, plano_status, criado_em)
           VALUES ($1, $2, $3, $4, 'ativo', $5) ON CONFLICT (email) DO NOTHING`,
          [m.id, m.email, hash, m.tipo_usuario, m.criado_em]
        );
        console.log(`Master seeded: ${m.email}`);
      }
    }
  } catch (err) {
    console.log("Could not seed master admin (DB may not exist yet):", err.message);
  }
}

initPool();
