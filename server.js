import express from 'express';
import { createServer } from 'http';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Módulos do sistema
import { initDB, query, isDBReady } from './src/database.js';
import { getAllAgents, getAgentStats, executeAgent, getAgentLogs } from './src/agents.js';
import { startEngine, runMission, getMissions, getCycle, getUptime, getUptimeSeconds, addSSEClient, broadcast, STARTED_AT } from './src/orchestrator.js';
import {
  ensureCRMSchema, listLeads, getLead, createLead, updateLeadStage, recalcLeadScore,
  addInteraction, getInteractions, scheduleFollowUp, getFollowUps,
  startFollowUpEngine, getPipelineStats, PIPELINE_STAGES
} from './src/crm.js';
import { mountSocialRoutes, PLATFORMS } from './src/social.js';
import { mountOAuthRoutes, getAllConnections } from './src/oauth2.js';
import { configureAI } from './src/ai.js';

// ===== Servidor Express =====
const app = express();
const httpServer = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ===== SSE — Stream de Logs em Tempo Real =====
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('event: connected\ndata: {}\n\n');
  addSSEClient(res);
});

// ===== API — Status do Sistema =====
app.get('/api/status', (req, res) => {
  const stats = getAgentStats();
  res.json({
    agents: stats.length,
    active: stats.filter(a => a.tasksCompleted > 0).length,
    totalMissions: getMissions().length,
    totalTasks: stats.reduce((s, a) => s + a.tasksCompleted, 0),
    dbConnected: isDBReady(),
    uptime: getUptimeSeconds(),
    uptimeDisplay: getUptime(),
    engineCycle: getCycle(),
    mode: isDBReady() ? 'production' : 'development',
    version: '2.0.0',
    startedAt: new Date(STARTED_AT).toISOString(),
  });
});

// ===== API — Agentes =====
app.get('/api/agents', (req, res) => {
  res.json(getAgentStats());
});

app.post('/api/agents/:id/execute', async (req, res) => {
  const { id } = req.params;
  const { input, source } = req.body;
  if (!input) return res.status(400).json({ error: 'Input obrigatório' });
  const result = await executeAgent(id, input, source || 'api');
  res.json(result);
});

app.get('/api/agents/:id/logs', async (req, res) => {
  res.json(await getAgentLogs(req.params.id));
});

// ===== API — Missões =====
app.get('/api/missions', (req, res) => {
  const limit = parseInt(req.query.limit) || 20;
  res.json(getMissions().slice(0, limit));
});

app.post('/api/mission', async (req, res) => {
  const { command, source } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando obrigatório' });
  res.json({ status: 'accepted', message: 'Missão iniciada' });
  runMission(command, source || 'manual').catch(err => {
    console.error('[MISSION ERROR]', err);
    broadcast('error', { message: err.message });
  });
});

// ===== API — CRM =====
app.get('/api/crm/pipeline', async (req, res) => {
  res.json({
    stages: PIPELINE_STAGES,
    stats: await getPipelineStats(),
  });
});

app.get('/api/crm/leads', async (req, res) => {
  const leads = await listLeads();
  const stage = req.query.stage;
  res.json(stage ? leads.filter(l => l.stage === stage) : leads);
});

app.get('/api/crm/leads/:id', async (req, res) => {
  const lead = await getLead(parseInt(req.params.id));
  if (!lead) return res.status(404).json({ error: 'Lead não encontrado' });
  lead.interactions = await getInteractions(lead.id);
  lead.followUps = await getFollowUps(lead.id);
  res.json(lead);
});

app.post('/api/crm/leads', async (req, res) => {
  res.json(await createLead(req.body));
});

app.patch('/api/crm/leads/:id/stage', async (req, res) => {
  const { stage } = req.body;
  if (!stage) return res.status(400).json({ error: 'Stage obrigatório' });
  try {
    res.json(await updateLeadStage(parseInt(req.params.id), stage));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/crm/leads/:id/score', async (req, res) => {
  res.json(await recalcLeadScore(parseInt(req.params.id)));
});

app.get('/api/crm/leads/:id/interactions', async (req, res) => {
  res.json(await getInteractions(parseInt(req.params.id)));
});

app.post('/api/crm/leads/:id/interactions', async (req, res) => {
  res.json(await addInteraction(parseInt(req.params.id), req.body));
});

app.post('/api/crm/leads/:id/followup', async (req, res) => {
  res.json(await scheduleFollowUp(parseInt(req.params.id)));
});

app.get('/api/crm/leads/:id/followups', async (req, res) => {
  res.json(await getFollowUps(parseInt(req.params.id)));
});

// ===== Mercado Pago Webhook =====
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
              email: payment.payer?.email || `mp_${paymentId}@email.com',
              source: 'mercadopago',
              origin: 'mercadopago',
              notes: `Pagamento #${paymentId} aprovado — R$ ${payment.transaction_amount}`,
            });
          }
        }
      } catch (e) {
        console.error('[MP] Erro:', e.message);
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[MP] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
});

// ===== Montar rotas especializadas =====
mountSocialRoutes(app);
mountOAuthRoutes(app);

// ===== Inicialização =====
async function start() {
  console.log('\n═══════════════════════════════════════════════');
  console.log('  ATHENA IA v2.0');
  console.log('  Enterprise Hyperautomation Engine');
  console.log('═══════════════════════════════════════════════\n');

  await initDB();
  await ensureCRMSchema();

  if (process.env.HF_TOKEN) configureAI({ hfToken: process.env.HF_TOKEN });
  if (process.env.GROQ_API_KEY) configureAI({ groqKey: process.env.GROQ_API_KEY });

  startEngine();
  startFollowUpEngine();

  httpServer.listen(PORT, () => {
    console.log(`  🌐 http://localhost:${PORT}`);
    console.log(`  💰 MP: ${process.env.MERCADO_PAGO_TOKEN ? '✓' : '✗'}`);
    console.log(`  🤖 IA: ${process.env.GROQ_API_KEY ? 'Groq' : process.env.HF_TOKEN ? 'HF' : 'Local'}`);
    console.log(`  🗄️  DB: ${isDBReady() ? 'PostgreSQL' : 'Memória'}`);
    console.log(`  ⚙️  Engine 24/7: ✓`);
    console.log(`  📡 CRM: ✓`);
    console.log(`  🔗 Social: 7 plataformas`);
    console.log(`  🔐 OAuth2: Central\n`);
  });
}

start();
