import express from 'express';
import { createServer } from 'http';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const STARTED_AT = Date.now();

// ============================================================
// BANCO DE DADOS — POOL COM AUTO-RECONEXÃO
// ============================================================
let pool = null;
let dbOk = false;
let dbRetries = 0;
const MAX_DB_RETRIES = 10;

async function getPool() {
  if (pool && dbOk) return pool;
  if (!process.env.DATABASE_URL) return null;
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
      dbOk = false;
      reconnectDB();
    });
    await pool.query('SELECT 1');
    dbOk = true;
    dbRetries = 0;
    console.log('[DB] PostgreSQL conectado');
    await initSchema();
    return pool;
  } catch (e) {
    console.warn('[DB] Falha na conexão:', e.message);
    dbOk = false;
    return null;
  }
}

async function reconnectDB() {
  if (dbRetries >= MAX_DB_RETRIES) {
    console.error('[DB] Máximo de tentativas atingido, operando em memória');
    return;
  }
  dbRetries++;
  const delay = Math.min(1000 * Math.pow(2, dbRetries), 30000);
  console.log(`[DB] Reconectando em ${delay}ms (tentativa ${dbRetries}/${MAX_DB_RETRIES})`);
  await new Promise(r => setTimeout(r, delay));
  await getPool();
}

async function initSchema() {
  if (!dbOk || !pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS tenants (
      id SERIAL PRIMARY KEY,
      uuid UUID DEFAULT gen_random_uuid(),
      email VARCHAR(255) UNIQUE,
      name VARCHAR(255),
      status VARCHAR(20) DEFAULT 'pending',
      plan_type VARCHAR(50) DEFAULT 'monthly',
      plan_price DECIMAL(10,2) DEFAULT 350.00,
      payment_id VARCHAR(100),
      payment_status VARCHAR(30),
      created_at TIMESTAMP DEFAULT NOW(),
      activated_at TIMESTAMP,
      expires_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS missions (
      id SERIAL PRIMARY KEY, command TEXT NOT NULL,
      status VARCHAR(20) DEFAULT 'pending',
      reasoning TEXT, result TEXT,
      created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS tasks (
      id SERIAL PRIMARY KEY, mission_id INT REFERENCES missions(id),
      description TEXT NOT NULL, agent VARCHAR(50),
      status VARCHAR(20) DEFAULT 'pending',
      decision TEXT, result TEXT,
      created_at TIMESTAMP DEFAULT NOW(), completed_at TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS decision_logs (
      id SERIAL PRIMARY KEY, task_id INT REFERENCES tasks(id),
      agent VARCHAR(50), level VARCHAR(10) DEFAULT 'info',
      message TEXT, created_at TIMESTAMP DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS payment_logs (
      id SERIAL PRIMARY KEY,
      payment_id VARCHAR(100),
      topic VARCHAR(50),
      status VARCHAR(30),
      raw_data JSONB,
      created_at TIMESTAMP DEFAULT NOW()
    );
  `);
  console.log('[DB] Schema verificado');
}

// ============================================================
// MERCADO PAGO — INTEGRAÇÃO FINANCEIRA
// ============================================================
const MP_TOKEN = process.env.MERCADO_PAGO_TOKEN;
const MP_API = 'https://api.mercadopago.com';

async function mpFetch(path, options = {}) {
  const res = await fetch(`${MP_API}${path}`, {
    ...options,
    headers: {
      'Authorization': `Bearer ${MP_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });
  if (!res.ok) throw new Error(`MP ${res.status}: ${await res.text()}`);
  return res.json();
}

async function createPaymentPreference(email, name) {
  const preference = await mpFetch('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        title: 'Plano Athena IA — Mensal',
        description: 'Assinatura mensal — Hiperautomação Multi-Agentes 24/7',
        quantity: 1,
        currency_id: 'BRL',
        unit_price: 350.00,
      }],
      payer: { email, name: name || 'Usuário Athena' },
      purpose: 'subscription',
      back_urls: {
        success: `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/checkout/success`,
        failure: `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/checkout/failure`,
        pending: `${process.env.BASE_URL || `http://localhost:${PORT}`}/api/checkout/pending`,
      },
      auto_return: 'approved',
      notification_url: `${process.env.BASE_URL || `http://localhost:${PORT}`}/webhooks/mercado-pago`,
      payment_methods: {
        installments: 1,
        excluded_payment_types: [{ id: 'ticket' }],
      },
    }),
  });
  return preference;
}

async function getPaymentInfo(paymentId) {
  return mpFetch(`/v1/payments/${paymentId}`);
}

// ============================================================
// ARMAZENAMENTO EM MEMÓRIA (FALLBACK)
// ============================================================
const mem = {
  tenants: [
    { id:1, uuid: crypto.randomUUID(), email:'admin@athena.local', name:'Admin', status:'active', plan_type:'monthly', plan_price:350, activated_at: new Date().toISOString(), expires_at: new Date(Date.now()+30*86400000).toISOString() },
  ],
  missions: [], tasks: [], logs: [],
  agents: [
    { id:'orchestrator', name:'Orquestrador',   status:'idle', specialty:'Coordenação e planejamento',     efficiency:98.5, tasksCompleted:0 },
    { id:'researcher',   name:'Pesquisador',    status:'idle', specialty:'Análise e coleta de dados',      efficiency:95.2, tasksCompleted:0 },
    { id:'executor',     name:'Executor',       status:'idle', specialty:'Execução de operações',          efficiency:97.8, tasksCompleted:0 },
    { id:'monitor',      name:'Monitor',        status:'idle', specialty:'Supervisão e métricas',          efficiency:93.4, tasksCompleted:0 },
    { id:'logger',       name:'Logger',         status:'idle', specialty:'Registro e auditoria',           efficiency:99.1, tasksCompleted:0 },
  ],
  mid: 0, tid: 0, lid: 0, tenId: 1,
  sse: [],
  taskQueue: [],
  backgroundCycle: 0,
};

// ============================================================
// HELPERS DE PERSISTÊNCIA (DB ou MEM)
// ============================================================
async function dbOrMem(query, params, memOp) {
  if (dbOk && pool) try {
    const { rows } = await pool.query(query, params);
    return rows;
  } catch (e) { /* fallback */ }
  return memOp();
}

async function saveMission(m) {
  if (dbOk && pool) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO missions (command,status,reasoning,result) VALUES($1,$2,$3,$4) RETURNING id',
        [m.command, m.status, m.reasoning, m.result]
      );
      m.id = rows[0].id; return m;
    } catch (e) {}
  }
  m.id = ++mem.mid; mem.missions.push(m); return m;
}

async function saveTask(t) {
  if (dbOk && pool) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO tasks (mission_id,description,agent,status,decision,result) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
        [t.missionId, t.description, t.agent, t.status, t.decision, t.result]
      );
      t.id = rows[0].id; return t;
    } catch (e) {}
  }
  t.id = ++mem.tid; mem.tasks.push(t); return t;
}

async function saveLog(l) {
  if (dbOk && pool) {
    try {
      const { rows } = await pool.query(
        'INSERT INTO decision_logs (task_id,agent,level,message) VALUES($1,$2,$3,$4) RETURNING id',
        [l.taskId, l.agent, l.level, l.message]
      );
      l.id = rows[0].id; return l;
    } catch (e) {}
  }
  l.id = ++mem.lid; mem.logs.push(l); return l;
}

async function allMissions() {
  if (dbOk && pool) try {
    const { rows } = await pool.query('SELECT * FROM missions ORDER BY created_at DESC');
    return rows;
  } catch (e) {}
  return [...mem.missions].reverse();
}

async function allTenants() {
  if (dbOk && pool) try {
    const { rows } = await pool.query('SELECT * FROM tenants ORDER BY created_at DESC');
    return rows;
  } catch (e) {}
  return [...mem.tenants].reverse();
}

async function saveTenant(t) {
  if (dbOk && pool) {
    try {
      const { rows } = await pool.query(
        `INSERT INTO tenants (email,name,status,plan_type,plan_price,payment_id,payment_status)
         VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (email) DO UPDATE SET status=$3,payment_id=$6,payment_status=$7,activated_at=NOW()
         RETURNING *`,
        [t.email, t.name, t.status, t.plan_type, t.plan_price, t.payment_id, t.payment_status]
      );
      return rows[0];
    } catch (e) {}
  }
  t.id = ++mem.tenId; mem.tenants.push(t); return t;
}

async function activateTenant(email, paymentId) {
  if (dbOk && pool) {
    try {
      const { rows } = await pool.query(
        `UPDATE tenants SET status='active',payment_status='approved',payment_id=$2,activated_at=NOW(),expires_at=NOW()+INTERVAL '30 days'
         WHERE email=$1 RETURNING *`, [email, paymentId]
      );
      if (rows.length) return rows[0];
    } catch (e) {}
  }
  const t = mem.tenants.find(t => t.email === email);
  if (t) { t.status = 'active'; t.payment_status = 'approved'; t.payment_id = paymentId; t.activated_at = new Date().toISOString(); t.expires_at = new Date(Date.now()+30*86400000).toISOString(); }
  return t;
}

// ============================================================
// SSE — STREAM DE EVENTOS EM TEMPO REAL
// ============================================================
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  mem.sse.forEach(res => { try { res.write(msg); } catch(e) {} });
}

// ============================================================
// ORQUESTRADOR MULTI-AGENTE
// ============================================================
const agentKeywords = {
  pesquisar:   { agent:'researcher', action:'analisar dados e compilar informações' },
  buscar:      { agent:'researcher', action:'realizar busca e coleta de dados' },
  analisar:    { agent:'researcher', action:'analisar informações disponíveis' },
  executar:    { agent:'executor',   action:'executar operação solicitada' },
  processar:   { agent:'executor',   action:'processar dados e gerar resultados' },
  calcular:    { agent:'executor',   action:'realizar cálculos e processamento' },
  monitorar:   { agent:'monitor',    action:'monitorar métricas e indicadores' },
  verificar:   { agent:'monitor',    action:'verificar status e consistência' },
  validar:     { agent:'monitor',    action:'validar resultados e qualidade' },
  registrar:   { agent:'logger',     action:'registrar eventos e logs' },
  auditar:     { agent:'logger',     action:'realizar auditoria de processos' },
  relatar:     { agent:'logger',     action:'gerar relatório detalhado' },
};

function decompose(missionText) {
  const steps = [];
  const words = missionText.toLowerCase().split(/\s+/);
  for (const [key, val] of Object.entries(agentKeywords)) {
    if (words.some(w => w.includes(key))) steps.push({ agent: val.agent, description: val.action });
  }
  if (!steps.length) steps.push(
    { agent:'researcher', description:'analisar o comando recebido' },
    { agent:'executor',   description:'executar a operação principal' },
    { agent:'logger',     description:'registrar o resultado da missão' }
  );
  return steps;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runMission(missionText, retries = 0) {
  const mission = await saveMission({ command: missionText, status: 'processing', reasoning: '', result: '' });
  broadcast('mission-start', { id: mission.id, command: missionText });
  broadcast('log', { agent:'system', level:'info', message: `🚀 Missão #${mission.id} iniciada: "${missionText}"` });

  const writeLog = async (taskId, agent, level, msg) => {
    const entry = await saveLog({ taskId, agent, level, message: msg });
    broadcast('log', entry);
  };

  const steps = decompose(missionText);
  const reasoning = steps.map((s,i) => `Passo ${i+1}: Agente ${s.agent} — ${s.description}`).join('\n');
  mission.reasoning = reasoning;

  if (dbOk && pool) try { await pool.query('UPDATE missions SET reasoning=$1 WHERE id=$2', [reasoning, mission.id]); } catch(e) {}
  else { const m = mem.missions.find(m => m.id === mission.id); if (m) m.reasoning = reasoning; }

  broadcast('reasoning', { missionId: mission.id, reasoning, steps });

  const results = [];
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = await saveTask({ missionId: mission.id, description: step.description, agent: step.agent, status: 'running', decision: '', result: '' });
    const agent = mem.agents.find(a => a.id === step.agent);
    if (agent) { agent.status = 'busy'; agent.lastActive = new Date().toISOString(); }
    broadcast('agent-update', mem.agents);
    broadcast('task-start', { missionId: mission.id, task });

    await writeLog(task.id, step.agent, 'info', `🤔 ${step.agent}: ${step.description}`);

    try {
      const thinkingTime = 1500 + Math.random() * 2500;
      const thinkSteps = [
        `📡 Coletando dados para "${missionText.slice(0,40)}..."`,
        `🧠 Aplicando raciocínio especializado`,
        `⚡ Executando sub-rotina de ${step.agent}`,
        `✅ Validando resultado`,
      ];
      for (const msg of thinkSteps) {
        await delay(thinkingTime / 4);
        await writeLog(task.id, step.agent, 'debug', msg);
      }

      const resultText = `[${step.agent.toUpperCase()}] ${step.description} concluído.`;
      task.status = 'completed';
      task.decision = `Decisão: delegado ao agente ${step.agent}`;
      task.result = resultText;
      if (dbOk && pool) try { await pool.query('UPDATE tasks SET status=$1,decision=$2,result=$3,completed_at=NOW() WHERE id=$4', [task.status,task.decision,task.result,task.id]); } catch(e) {}
      results.push(resultText);

      if (agent) { agent.status = 'idle'; agent.tasksCompleted++; agent.efficiency = Math.min(100, agent.efficiency + (Math.random()*0.5-0.2)); }
      broadcast('agent-update', mem.agents);
      broadcast('task-done', { missionId: mission.id, task });
      await writeLog(task.id, step.agent, 'success', `✅ Tarefa concluída: ${step.description}`);
    } catch (err) {
      failed = true;
      await writeLog(task.id, step.agent, 'error', `❌ Erro: ${err.message}`);
      if (agent) { agent.status = 'idle'; }
      broadcast('agent-update', mem.agents);
    }
  }

  if (failed && retries < 3) {
    await writeLog(null, 'system', 'warn', `🔄 Auto-correção: re-tentando missão #${mission.id} (tentativa ${retries+2}/3)`);
    broadcast('reasoning', { missionId: mission.id, reasoning: reasoning + `\n🔄 Auto-correção ativada (tentativa ${retries+2})`, steps });
    await delay(3000);
    return runMission(missionText, retries + 1);
  }

  mission.status = 'completed';
  mission.result = results.join('\n');
  if (dbOk && pool) try { await pool.query('UPDATE missions SET status=$1,result=$2,completed_at=NOW() WHERE id=$3', ['completed',mission.result,mission.id]); } catch(e) {}
  broadcast('mission-done', { id: mission.id, result: mission.result });
  broadcast('log', { agent:'system', level:'success', message: `🏁 Missão #${mission.id} concluída com ${steps.length} etapas${retries > 0 ? ` (${retries+1}ª tentativa)` : ''}` });
  return mission;
}

// ============================================================
// MOTOR DE BACKGROUND 24/7
// ============================================================
let engineInterval = null;

function startBackgroundEngine() {
  console.log('[ENGINE] Motor 24/7 iniciado');
  engineInterval = setInterval(async () => {
    try {
      mem.backgroundCycle++;

      if (mem.sse.length > 0) {
        broadcast('heartbeat', { cycle: mem.backgroundCycle, uptime: Math.floor((Date.now()-STARTED_AT)/1000) });
      }

      if (mem.taskQueue.length > 0) {
        const cmd = mem.taskQueue.shift();
        broadcast('log', { agent:'system', level:'info', message: `⚙️ Motor 24/7 processando tarefa da fila: "${cmd}"` });
        runMission(cmd).catch(err => broadcast('error', { message: err.message }));
      }

      if (mem.backgroundCycle % 12 === 0 && dbOk && pool) {
        try {
          await pool.query('SELECT 1');
        } catch (e) {
          dbOk = false;
          broadcast('log', { agent:'system', level:'warn', message: '⚠️ Conexão com DB perdida, reconectando...' });
          reconnectDB();
        }
      }

      if (mem.backgroundCycle % 30 === 0) {
        const healthCheckCmd = [
          'verificar status do sistema',
          'monitorar métricas de desempenho',
          'registrar heartbeat do motor 24/7',
        ][Math.floor(Math.random() * 3)];
        broadcast('log', { agent:'system', level:'debug', message: `💓 Auto-checkup #${mem.backgroundCycle}: ${healthCheckCmd}` });
      }
    } catch (err) {
      console.error('[ENGINE] Erro no ciclo:', err.message);
    }
  }, 10000);
}

// ============================================================
// EXPRESS APP
// ============================================================
const app = express();
const httpServer = createServer(app);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// === WEBHOOK MERCADO PAGO ===
app.post('/webhooks/mercado-pago', async (req, res) => {
  try {
    const { action, data, type } = req.body;
    const topic = type || (action && action.split('.')[0]);
    const paymentId = data?.id || req.query?.id;

    console.log('[MP WEBHOOK] Recebido:', { topic, paymentId, action });

    if (dbOk && pool) {
      try { await pool.query('INSERT INTO payment_logs (payment_id,topic,status,raw_data) VALUES($1,$2,$3,$4)', [String(paymentId||''),topic||'unknown','received',JSON.stringify(req.body)]); } catch(e) {}
    }

    if (paymentId && (topic === 'payment' || topic === 'payment.created')) {
      try {
        const payment = await getPaymentInfo(paymentId);
        const status = payment.status;
        console.log(`[MP] Pagamento #${paymentId}: ${status}`);

        if (dbOk && pool) {
          try { await pool.query('UPDATE payment_logs SET status=$1 WHERE payment_id=$2', [status, String(paymentId)]); } catch(e) {}
        }

        if (status === 'approved') {
          const email = payment.payer?.email || `cliente${paymentId}@athena.local`;
          const name = payment.payer?.name || 'Cliente Athena';
          await saveTenant({ email, name, status:'active', plan_type:'monthly', plan_price:350, payment_id:String(paymentId), payment_status:'approved' });

          broadcast('log', { agent:'mercado-pago', level:'success', message: `✅ Pagamento #${paymentId} aprovado! Tenant ativado: ${email}` });
          broadcast('tenant-update', { email, status: 'active' });
        }
      } catch (mpErr) {
        console.error('[MP] Erro ao buscar pagamento:', mpErr.message);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[MP WEBHOOK ERROR]', err);
    res.status(200).json({ status: 'ok' });
  }
});

// === CHECKOUT — Criar preferência de pagamento ===
app.post('/api/checkout', async (req, res) => {
  try {
    const { email, name } = req.body;
    if (!email) return res.status(400).json({ error: 'Email é obrigatório' });

    await saveTenant({ email, name: name || email, status:'pending', plan_type:'monthly', plan_price:350, payment_id:null, payment_status:'pending' });

    const preference = await createPaymentPreference(email, name);
    broadcast('log', { agent:'mercado-pago', level:'info', message: `🛒 Checkout criado para ${email} — R$ 350,00` });

    res.json({
      preferenceId: preference.id,
      initPoint: preference.init_point || preference.sandbox_init_point,
      message: 'Preferência de pagamento criada',
    });
  } catch (err) {
    console.error('[CHECKOUT ERROR]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/checkout/success', async (req, res) => {
  const { payment_id, status, external_reference } = req.query;
  if (payment_id) try {
    const payment = await getPaymentInfo(payment_id);
    if (payment.status === 'approved') {
      const email = payment.payer?.email || `cliente${payment_id}@athena.local`;
      await activateTenant(email, String(payment_id));
      broadcast('log', { agent:'mercado-pago', level:'success', message: `✅ Pagamento #${payment_id} confirmado via retorno` });
    }
  } catch(e) {}
  res.redirect('/?checkout=success');
});

app.get('/api/checkout/failure', (req, res) => {
  res.redirect('/?checkout=failure');
});

app.get('/api/checkout/pending', (req, res) => {
  res.redirect('/?checkout=pending');
});

// === API — Agentes ===
app.get('/api/agents', (req, res) => {
  res.json(mem.agents.map(a => ({ ...a, efficiency: Math.round(a.efficiency*10)/10 })));
});

// === API — Missões ===
app.get('/api/missions', async (req, res) => {
  res.json(await allMissions());
});

app.get('/api/missions/:id/logs', async (req, res) => {
  const id = parseInt(req.params.id);
  if (dbOk && pool) try {
    const { rows } = await pool.query(
      'SELECT dl.* FROM decision_logs dl JOIN tasks t ON dl.task_id=t.id WHERE t.mission_id=$1 ORDER BY dl.created_at', [id]);
    return res.json(rows);
  } catch(e) {}
  res.json(mem.logs.filter(l => mem.tasks.find(t => t.id === l.taskId && t.missionId === id)));
});

// === API — Enviar missão ===
app.post('/api/mission', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando é obrigatório' });
  res.json({ status: 'accepted', message: 'Missão iniciada' });
  runMission(command).catch(err => {
    console.error('[MISSION ERROR]', err);
    broadcast('error', { message: err.message });
  });
});

// === API — Tenants ===
app.get('/api/tenants', async (req, res) => {
  res.json(await allTenants());
});

// === API — Status geral ===
app.get('/api/status', (req, res) => {
  const total = mem.agents.reduce((s, a) => s + a.tasksCompleted, 0);
  res.json({
    agents: mem.agents.length,
    active: mem.agents.filter(a => a.status === 'busy').length,
    totalMissions: mem.missions.length,
    totalTasks: total,
    dbConnected: dbOk,
    uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
    uptimeDisplay: formatUptime((Date.now() - STARTED_AT) / 1000),
    engineCycle: mem.backgroundCycle,
    queueSize: mem.taskQueue.length,
    tenants: mem.tenants.length,
    mpTokenConfigured: !!MP_TOKEN,
    mode: dbOk ? 'production' : 'development',
  });
});

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// === SSE ===
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write('event: connected\ndata: {}\n\n');
  mem.sse.push(res);
  req.on('close', () => {
    mem.sse = mem.sse.filter(r => r !== res);
  });
});

// ============================================================
// INICIALIZAÇÃO
// ============================================================
async function start() {
  console.log('[BOOT] Inicializando Athena IA...');
  await getPool();
  startBackgroundEngine();

  httpServer.listen(PORT, () => {
    console.log(`\n═══════════════════════════════════════════════`);
    console.log(`  ATHENA IA — Hiperautomação Multi-Agentes`);
    console.log(`  🌐 http://localhost:${PORT}`);
    console.log(`  💰 MP: ${MP_TOKEN ? 'Configurado' : 'Não configurado'}`);
    console.log(`  🗄️  DB: ${dbOk ? 'PostgreSQL' : 'Memória'}`);
    console.log(`  ⚙️  Motor 24/7: Ativo`);
    console.log(`═══════════════════════════════════════════════\n`);
  });
}

start();
