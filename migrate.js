import "dotenv/config";
import pkg from "pg";
import bcrypt from "bcrypt";
import crypto from "crypto";

const { Pool } = pkg;

const MASTERS = [
  { id: "00000000-0000-0000-0000-000000000000", email: "master@athenaia.com", password: "Master@2026" },
  { id: "00000000-0000-0000-0000-000000000001", email: "armarinhodajack@gmail.com", password: "Master@2026" },
];

async function migrate() {
  if (!process.env.DATABASE_URL) {
    console.log("DATABASE_URL not set. Set it in .env to run migration against PostgreSQL.");
    console.log("Example:");
    console.log('  DATABASE_URL="postgresql://user:password@host:5432/athena_db"');
    console.log("\nRunning with in-memory fallback — no migration needed.");
    process.exit(0);
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
  });

  try {
    await pool.query("SELECT 1");
    console.log("Connected to PostgreSQL successfully.");
  } catch (err) {
    console.error("Could not connect to PostgreSQL:", err.message);
    process.exit(1);
  }

  try {
    console.log("Running migration: creating usuarios table...");

    await pool.query(`
      CREATE TABLE IF NOT EXISTS usuarios (
        id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        email       VARCHAR(255) UNIQUE NOT NULL,
        password    VARCHAR(255) NOT NULL,
        tipo_usuario VARCHAR(20) NOT NULL DEFAULT 'cliente' CHECK (tipo_usuario IN ('master', 'cliente')),
        plano_status VARCHAR(20) NOT NULL DEFAULT 'ativo' CHECK (plano_status IN ('ativo', 'inadimplente')),
        criado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    console.log("Table 'usuarios' is ready.");

    for (const m of MASTERS) {
      const hash = await bcrypt.hash(m.password, 10);
      await pool.query(
        `INSERT INTO usuarios (id, email, password, tipo_usuario, plano_status, criado_em)
         VALUES ($1, $2, $3, 'master', 'ativo', NOW())
         ON CONFLICT (email) DO UPDATE SET password = EXCLUDED.password`,
        [m.id, m.email, hash]
      );
      console.log(`  Master seeded: ${m.email}`);
    }

    console.log("  Tipo: master (vitalício)");
    console.log("\nMigration complete!");

    const count = await pool.query("SELECT COUNT(*) FROM usuarios");
    console.log(`Total users in database: ${count.rows[0].count}`);

    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    await pool.end();
    process.exit(1);
  }
}

migrate();
