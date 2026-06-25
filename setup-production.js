import dotenv from 'dotenv';
import { exec } from 'child_process';

dotenv.config();

const REQUIRED_ENV_VARS = [
  'DATABASE_URL',
  'MERCADO_PAGO_TOKEN',
  'JWT_SECRET',
];

console.log('=== 🦉 INICIANDO CHECAGEM DA ATHENA ENGINE PERMANENTE 24H ===\n');

// 1. Validar Variáveis de Ambiente obrigatórias
const missing = REQUIRED_ENV_VARS.filter(key => !process.env[key]);

if (missing.length > 0) {
  console.error('❌ ERRO CRÍTICO: Variáveis obrigatórias ausentes no .env:');
  console.error(missing.join(', '));
  process.exit(1);
}

console.log('✅ Todas as credenciais de produção foram encontradas.');
console.log(`   • DATABASE_URL: ${(process.env.DATABASE_URL || '').slice(0, 20)}...`);
console.log(`   • MERCADO_PAGO_TOKEN: ${process.env.MERCADO_PAGO_TOKEN ? 'Configurado' : 'Ausente (opcional para dev)'}`);
console.log(`   • JWT_SECRET: ${process.env.JWT_SECRET ? 'Configurado (fallback automático)' : 'Usando fallback padrão'}`);

// 2. Verificar variáveis opcionais
const optional = ['HF_TOKEN', 'GROQ_API_KEY', 'WHATSAPP_VERIFY_TOKEN'];
const found = optional.filter(k => process.env[k]);
if (found.length) console.log(`ℹ️  Extras: ${found.join(', ')}`);
else console.log('ℹ️  Nenhuma variável extra configurada (IA usará processamento local)');

// 3. Verificar estrutura de arquivos
const fs = await import('fs');
const requiredFiles = ['server.js', 'index.html', 'src/database.js', 'src/auth.js', 'src/rpa_orchestrator.js'];
const missingFiles = requiredFiles.filter(f => !fs.existsSync(f));
if (missingFiles.length) {
  console.error(`❌ Arquivos ausentes: ${missingFiles.join(', ')}`);
  process.exit(1);
}
console.log('✅ Estrutura de arquivos completa.');

// 4. Testar sintaxe do servidor
console.log('\n🔍 Validando sintaxe do servidor...');
try {
  const { spawnSync } = await import('child_process');
  const result = spawnSync('node', ['--check', 'server.js'], { stdio: 'pipe' });
  if (result.status !== 0) {
    console.error('❌ Erro de sintaxe em server.js:', result.stderr.toString());
    process.exit(1);
  }
  console.log('✅ server.js — sintaxe OK');
} catch (e) {
  console.warn('⚠️  Não foi possível validar sintaxe:', e.message);
}

// 5. Subir servidor
console.log('\n🚀 Ligando motores do Orchestrator e subindo servidores...\n');

const child = exec('node server.js', { stdio: 'pipe' });

child.stdout.on('data', (data) => process.stdout.write(`[Athena] ${data}`));
child.stderr.on('data', (data) => process.stderr.write(`[Athena Error] ${data}`));

child.on('exit', (code) => {
  if (code !== 0 && code !== null) {
    console.error(`❌ Servidor encerrou com código ${code}`);
    process.exit(code);
  }
});

process.on('SIGINT', () => { child.kill(); process.exit(); });
process.on('SIGTERM', () => { child.kill(); process.exit(); });

console.log('✅ Athena Engine rodando 24/7. Pressione Ctrl+C para parar.\n');
