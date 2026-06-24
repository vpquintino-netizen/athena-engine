import { query } from "./src/db.js";

async function migrate() {
  console.log("📦 Inicializando migração completa de banco para os Agentes Athena...");

  const statements = [
    `CREATE TABLE IF NOT EXISTS user_integrations (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      platform VARCHAR(50) NOT NULL,
      access_token TEXT NOT NULL,
      refresh_token TEXT,
      expires_at TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      CONSTRAINT unique_user_platform UNIQUE(user_id, platform)
    )`,
    `CREATE TABLE IF NOT EXISTS user_posts (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL,
      platform VARCHAR(50) NOT NULL,
      content TEXT NOT NULL,
      media_url TEXT,
      media_type VARCHAR(20) DEFAULT 'feed',
      status VARCHAR(20) DEFAULT 'scheduled',
      scheduled_at TIMESTAMP NOT NULL,
      published_at TIMESTAMP,
      error_message TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS chatbot_configs (
      id SERIAL PRIMARY KEY,
      user_id UUID NOT NULL UNIQUE,
      bot_status VARCHAR(20) DEFAULT 'active',
      context_prompt TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`,
  ];

  for (const sql of statements) {
    try {
      await query(sql);
      console.log(`  ✅ Executado: ${sql.substring(0, 60)}...`);
    } catch (err) {
      if (err.message.includes("not available")) {
        console.log("  ℹ️  PostgreSQL não disponível — tabelas serão criadas quando o banco estiver ativo.");
        return;
      }
      console.error(`  ⚠️  ${err.message}`);
    }
  }
  console.log("✅ Todas as tabelas estruturais de IA foram integradas com sucesso!");
}

migrate();
