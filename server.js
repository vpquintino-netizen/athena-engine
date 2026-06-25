import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

import { initDB, query, isDBReady } from './src/database.js';
import { getAllAgents, getAgentStats, executeAgent, getAgentLogs } from './src/agents.js';
import { startEngine, runMission, getMissions, getCycle, getUptime, getUptimeSeconds, addSSEClient, broadcast, STARTED_AT } from './src/orchestrator.js';
import {
  ensureCRMSchema, listLeads, getLead, createLead, updateLeadStage, recalcLeadScore,
  addInteraction, getInteractions, scheduleFollowUp, getFollowUps,
  startFollowUpEngine, getPipelineStats, PIPELINE_STAGES
} from './src/crm.js';
import { mountSocialRoutes } from './src/social.js';
import { mountOAuthRoutes } from './src/oauth2.js';
import { configureAI } from './src/ai.js';
import { mountAuthRoutes, authMiddleware, optionalAuth, masterOnly, subscriptionRequired, tenantIsolation, ensureAuthSchema, verifyToken } from './src/auth.js';
import { mountBrandingRoutes } from './src/branding.js';
import { startRPAEngine, ensureRPASchema, getRPAStats } from './src/rpa_orchestrator.js';
import { mountRPARoutes, scheduleAutomatedTasks } from './src/agents_rpa.js';

const app = express();
const httpServer = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ===== Middleware global: opcionalmente anexa user às requests =====
app.use((req, res, next) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    req.user = verifyToken(header.slice(7));
  }
  next();
});

// ===== Health Check (monitoramento Render / UptimeRobot) =====
app.get('/health', async (req, res) => {
  try {
    const dbOk = isDBReady();
    if (dbOk) await query('SELECT NOW()');
    res.status(200).json({
      status: dbOk ? 'ONLINE' : 'DEGRADED',
      timestamp: new Date().toISOString(),
      database: dbOk ? 'CONNECTED' : 'MEMORY_FALLBACK',
      orchestrator: 'RUNNING',
      rpaEngine: 'ACTIVE',
      uptime: process.uptime(),
      uptimeDisplay: getUptime(),
      version: '2.2.0',
    });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', error: err.message });
  }
});

// ===== Rotas públicas (sem auth) =====
app.get('/api/status', (req, res) => {
  const stats = getAgentStats();
  res.json({
    agents: stats.length, active: stats.filter(a => a.tasksCompleted > 0).length,
    totalMissions: getMissions().length, totalTasks: stats.reduce((s, a) => s + a.tasksCompleted, 0),
    dbConnected: isDBReady(), uptime: getUptimeSeconds(), uptimeDisplay: getUptime(),
    engineCycle: getCycle(), mode: isDBReady() ? 'production' : 'development',
    version: '2.1.0', startedAt: new Date(STARTED_AT).toISOString(),
    authRequired: !req.user, authenticated: !!req.user,
    rpaActive: true, rpaRobots: 8,
    user: req.user ? { email: req.user.email, role: req.user.role, tenant_uuid: req.user.tenant_uuid } : null,
  });
});

// ===== Rotas públicas: Agentes (leitura) =====
app.get('/api/agents', (req, res) => res.json(getAgentStats()));
app.get('/api/missions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(getMissions().slice(0, limit));
});

// ===== SSE (público, mas filtra por tenant) =====
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
    Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
  });
  res.write('event: connected\ndata: {}\n\n');
  addSSEClient(res);
});

// ===== Rotas protegidas (requerem auth) =====
app.post('/api/mission', authMiddleware, async (req, res) => {
  const { command, source } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando obrigatório' });
  res.json({ status: 'accepted', message: 'Missão iniciada' });
  runMission(command, source || 'manual').catch(err => { console.error('[MISSION ERROR]', err); broadcast('error', { message: err.message }); });
});

app.post('/api/agents/:id/execute', authMiddleware, async (req, res) => {
  const { id } = req.params;
  const { input, source } = req.body;
  if (!input) return res.status(400).json({ error: 'Input obrigatório' });
  const result = await executeAgent(id, input, source || 'api');
  res.json(result);
});

app.get('/api/agents/:id/logs', authMiddleware, async (req, res) => {
  res.json(await getAgentLogs(req.params.id));
});

// ===== CRM (protegido + tenant isolation) =====
app.get('/api/crm/pipeline', authMiddleware, async (req, res) => {
  res.json({ stages: PIPELINE_STAGES, stats: await getPipelineStats() });
});

app.get('/api/crm/leads', authMiddleware, async (req, res) => {
  const leads = await listLeads();
  const stage = req.query.stage;
  res.json(stage ? leads.filter(l => l.stage === stage) : leads);
});

app.get('/api/crm/leads/:id', authMiddleware, async (req, res) => {
  const lead = await getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  lead.interactions = await getInteractions(lead.id);
  lead.followUps = await getFollowUps(lead.id);
  res.json(lead);
});

app.post('/api/crm/leads', authMiddleware, async (req, res) => res.json(await createLead(req.body)));
app.patch('/api/crm/leads/:id/stage', authMiddleware, async (req, res) => {
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ error: 'Stage obrigatório' });
  try { res.json(await updateLeadStage(parseInt(req.params.id), stage)); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/crm/leads/:id/score', authMiddleware, async (req, res) => res.json(await recalcLeadScore(parseInt(req.params.id))));
app.get('/api/crm/leads/:id/interactions', authMiddleware, async (req, res) => res.json(await getInteractions(parseInt(req.params.id))));
app.post('/api/crm/leads/:id/interactions', authMiddleware, async (req, res) => res.json(await addInteraction(parseInt(req.params.id), req.body)));
app.post('/api/crm/leads/:id/followup', authMiddleware, async (req, res) => res.json(await scheduleFollowUp(parseInt(req.params.id))));
app.get('/api/crm/leads/:id/followups', authMiddleware, async (req, res) => res.json(await getFollowUps(parseInt(req.params.id))));

// ===== Mercado Pago Webhook (público) =====
app.post('/webhooks/mercado-pago', async (req, res) => {
  try {
    const { action, data, type } = req.body;
    const paymentId = data?.id || req.query?.id;
    console.log('[MP] Webhook:', { action, type, paymentId });
    if (paymentId && (type === 'payment' || action?.startsWith('payment'))) {
      try {
        const mpRes = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
          headers: { 'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}` }
        });
        if (mpRes.ok) {
          const payment = await mpRes.json();
          broadcast('log', { agent: 'mercado-pago', level: 'info', message: `💳 Pagamento #${paymentId}: ${payment.status}` });
          if (payment.status === 'approved') {
            await createLead({
              name: payment.payer?.name || 'Cliente MP',
              email: payment.payer?.email || `mp_${paymentId}@email.com`,
              source: 'mercadopago', origin: 'mercadopago',
              notes: `Pagamento #${paymentId} aprovado — R$ ${payment.transaction_amount}`,
            });
          }
        }
      } catch (e) { console.error('[MP] Erro:', e.message); }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) { console.error('[MP] Error:', err.message); res.status(200).json({ status: 'ok' }); }
});

// ===== Montar módulos de rotas =====
mountAuthRoutes(app);
mountSocialRoutes(app);
mountOAuthRoutes(app);
mountBrandingRoutes(app);
mountRPARoutes(app);

// ===== Checkout protegido =====
app.post('/api/checkout', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email é obrigatório' });
    const mpRes = await fetch('https://api.mercadopago.com/checkout/preferences', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: [{ title: 'Plano Athena IA — Mensal', quantity: 1, currency_id: 'BRL', unit_price: 350 }],
        payer: { email, name: name || email },
        purpose: 'subscription',
        back_urls: { success: `${process.env.BASE_URL || `http://localhost:${PORT}`}/?checkout=success`, failure: `${process.env.BASE_URL || `http://localhost:${PORT}`}/?checkout=failure`, pending: `${process.env.BASE_URL || `http://localhost:${PORT}`}/?checkout=pending` },
        auto_return: 'approved',
        notification_url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/webhooks/mercado-pago`,
      }),
    });
    const pref = await mpRes.json();
    res.json({ preferenceId: pref.id, initPoint: pref.init_point || pref.sandbox_init_point });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== Inicialização =====
async function start() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  ATHENA IA v2.1');
  console.log('  Enterprise Hyperautomation Engine');
  console.log('═══════════════════════════════════════════════\n');

  await initDB();
  await ensureCRMSchema();
  await ensureAuthSchema();

  if (process.env.HF_TOKEN) configureAI({ hfToken: process.env.HF_TOKEN });
  if (process.env.GROQ_API_KEY) configureAI({ groqKey: process.env.GROQ_API_KEY });

  startEngine();
  startFollowUpEngine();
  await ensureRPASchema();
  startRPAEngine();
  scheduleAutomatedTasks().catch(() => {});

  httpServer.listen(PORT, () => {
    console.log(`  🌐 http://localhost:${PORT}`);
    console.log(`  🔐 Auth: JWT + Master Bypass`);
    console.log(`  💰 MP: ${process.env.MERCADO_PAGO_TOKEN ? '✓' : '✗'}`);
    console.log(`  🤖 IA: ${process.env.GROQ_API_KEY ? 'Groq' : process.env.HF_TOKEN ? 'HF' : 'Local'}`);
    console.log(`  🗄️  DB: ${isDBReady() ? 'PostgreSQL' : 'Memória'}`);
    console.log(`  📦 SaaS: R$ 350/mês`);
    console.log(`  🆓 Freemium: ✓`);
    console.log(`  🎨 White-Label: ✓`);
    console.log(`  🤖 RPA Orchestrator: 8 Digital Workers`);
    console.log(`  ⚙️  Engine 24/7: ✓\n`);
  });
}

start();
