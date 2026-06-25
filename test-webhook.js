import http from 'http';

const PORT = process.argv[2] || 3000;
const HOST = process.argv[3] || 'localhost';

const payload = JSON.stringify({
  action: 'payment.created',
  api_version: 'v1',
  data: { id: '9998887776' },
  date_created: new Date().toISOString(),
  id: 123456789,
  live_mode: false,
  type: 'payment',
  user_id: 'athena_saas_test',
});

const options = {
  hostname: HOST,
  port: PORT,
  path: '/webhooks/mercado-pago',
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  },
};

console.log('═══════════════════════════════════════════════');
console.log('  📡 Athena IA — Simulador de Webhook MP');
console.log('═══════════════════════════════════════════════');
console.log(`\n🎯 Alvo: http://${HOST}:${PORT}/webhooks/mercado-pago`);
console.log(`💳 Pagamento: R$ 350,00 (ID fictício: 9998887776)`);
console.log(`📦 Payload: ${payload}\n`);

console.log('📡 Disparando payload de simulação de compra aprovada...');

const req = http.request(options, (res) => {
  let data = '';
  res.on('data', (chunk) => (data += chunk));
  res.on('end', () => {
    console.log(`\n✅ STATUS HTTP: ${res.statusCode}`);
    console.log(`📬 RESPOSTA DO BACKEND: ${data}`);
    console.log(`\n📊 Verifique:\n` +
      `   • Banco de dados / admin.html para logs\n` +
      `   • Painel Athena IA → Aba CRM → Pipeline\n` +
      `   • Logs em tempo real no Dashboard\n`);
  });
});

req.on('error', (e) => {
  console.error(`\n❌ Falha ao conectar no servidor local: ${e.message}`);
  console.log(`\n   Certifique-se de que o servidor está rodando:`);
  console.log(`   node server.js\n`);
});

req.write(payload);
req.end();
