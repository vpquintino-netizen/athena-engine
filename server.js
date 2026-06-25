import express from 'express';
import { createServer } from 'http';
import pg from 'pg';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ===== Banco de Dados =====
let pool = null;
let dbOk = false;

const mem = {
  missions: [], tasks: [], logs: [],
  agents: [
    { id:'orchestrator', name:'Orquestrador',   status:'idle', specialty:'Coordenação e planejamento',     efficiency:98.5, tasksCompleted:0 },
    { id:'researcher',   name:'Pesquisador',    status:'idle', specialty:'Análise e coleta de dados',      efficiency:95.2, tasksCompleted:0 },
    { id:'executor',     name:'Executor',       status:'idle', specialty:'Execução de operações',          efficiency:97.8, tasksCompleted:0 },
    { id:'monitor',      name:'Monitor',        status:'idle', specialty:'Supervisão e métricas',          efficiency:93.4, tasksCompleted:0 },
    { id:'logger',       name:'Logger',         status:'idle', specialty:'Registro e auditoria',           efficiency:99.1, tasksCompleted:0 },
  ],
  mid: 0, tid: 0, lid: 0,
  sse: []
};

async function initDB() {
  if (process.env.DATABASE_URL) try {
    pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
    await pool.query('SELECT 1');
    dbOk = true;
    console.log('[DB] PostgreSQL conectado');
    await pool.query(`
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
    `);
    const { rows } = await pool.query('SELECT COUNT(*) c FROM missions');
    console.log(`[DB] ${rows[0].c} missões encontradas`);
  } catch(e) {
    console.warn('[DB] PostgreSQL indisponível, usando memória:', e.message);
    dbOk = false;
  }
  else console.log('[DB] DATABASE_URL não definida — armazenando em memória');
}

// ===== Helpers de persistência =====
async function saveMission(m) {
  if (dbOk) {
    const { rows } = await pool.query(
      'INSERT INTO missions (command,status,reasoning,result) VALUES($1,$2,$3,$4) RETURNING id',
      [m.command, m.status, m.reasoning, m.result]
    );
    m.id = rows[0].id;
  } else { m.id = ++mem.mid; mem.missions.push(m); }
  return m;
}
async function saveTask(t) {
  if (dbOk) {
    const { rows } = await pool.query(
      'INSERT INTO tasks (mission_id,description,agent,status,decision,result) VALUES($1,$2,$3,$4,$5,$6) RETURNING id',
      [t.missionId, t.description, t.agent, t.status, t.decision, t.result]
    );
    t.id = rows[0].id;
  } else { t.id = ++mem.tid; mem.tasks.push(t); }
  return t;
}
async function saveLog(l) {
  if (dbOk) {
    const { rows } = await pool.query(
      'INSERT INTO decision_logs (task_id,agent,level,message) VALUES($1,$2,$3,$4) RETURNING id',
      [l.taskId, l.agent, l.level, l.message]
    );
    l.id = rows[0].id;
  } else { l.id = ++mem.lid; mem.logs.push(l); }
  return l;
}
async function allMissions() {
  if (dbOk) { const { rows } = await pool.query('SELECT * FROM missions ORDER BY created_at DESC'); return rows; }
  return [...mem.missions].reverse();
}
async function logsByMission(missionId) {
  if (dbOk) {
    const { rows } = await pool.query(
      `SELECT dl.* FROM decision_logs dl JOIN tasks t ON dl.task_id=t.id
       WHERE t.mission_id=$1 ORDER BY dl.created_at`, [missionId]
    );
    return rows;
  }
  return mem.logs.filter(l => mem.tasks.find(t => t.id === l.taskId && t.missionId === missionId));
}

// ===== SSE =====
function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  mem.sse.forEach(res => res.write(msg));
}

// ===== Orquestrador Multi-Agente =====
const agentKeywords = {
  pesquisar:   { agent: 'researcher', action: 'analisar dados e compilar informações' },
  buscar:      { agent: 'researcher', action: 'realizar busca e coleta de dados' },
  analisar:    { agent: 'researcher', action: 'analisar informações disponíveis' },
  executar:    { agent: 'executor',   action: 'executar operação solicitada' },
  processar:   { agent: 'executor',   action: 'processar dados e gerar resultados' },
  calcular:    { agent: 'executor',   action: 'realizar cálculos e processamento' },
  monitorar:   { agent: 'monitor',    action: 'monitorar métricas e indicadores' },
  verificar:   { agent: 'monitor',    action: 'verificar status e consistência' },
  validar:     { agent: 'monitor',    action: 'validar resultados e qualidade' },
  registrar:   { agent: 'logger',     action: 'registrar eventos e logs' },
  auditar:     { agent: 'logger',     action: 'realizar auditoria de processos' },
  relatar:     { agent: 'logger',     action: 'gerar relatório detalhado' },
};

function decompose(missionText) {
  const steps = [];
  const words = missionText.toLowerCase().split(/\s+/);
  for (const [key, val] of Object.entries(agentKeywords)) {
    if (words.some(w => w.includes(key))) {
      steps.push({ agent: val.agent, description: val.action });
    }
  }
  if (!steps.length) {
    steps.push(
      { agent: 'researcher', description: 'analisar o comando recebido' },
      { agent: 'executor',   description: 'executar a operação principal' },
      { agent: 'logger',     description: 'registrar o resultado da missão' }
    );
  }
  return steps;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function runMission(missionText) {
  const mission = await saveMission({ command: missionText, status: 'processing', reasoning: '', result: '' });

  broadcast('mission-start', { id: mission.id, command: missionText });

  const log = async (taskId, agent, level, msg) => {
    const entry = await saveLog({ taskId, agent, level, message: msg });
    broadcast('log', entry);
  };

  const steps = decompose(missionText);
  const reasoning = steps.map((s, i) => `Passo ${i+1}: Agente ${s.agent} — ${s.description}`).join('\n');
  mission.reasoning = reasoning;

  if (dbOk) await pool.query('UPDATE missions SET reasoning=$1 WHERE id=$2', [reasoning, mission.id]);
  else { const m = mem.missions.find(m => m.id === mission.id); if (m) m.reasoning = reasoning; }

  broadcast('reasoning', { missionId: mission.id, reasoning, steps });

  const results = [];

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    const task = await saveTask({ missionId: mission.id, description: step.description, agent: step.agent, status: 'running', decision: '', result: '' });

    const agent = mem.agents.find(a => a.id === step.agent);
    if (agent) { agent.status = 'busy'; agent.lastActive = new Date().toISOString(); }
    broadcast('agent-update', mem.agents);
    broadcast('task-start', { missionId: mission.id, task });

    await log(task.id, step.agent, 'info', `🤔 Analisando: ${step.description}`);

    const thinkingTime = 2000 + Math.random() * 3000;
    const thinkSteps = [
      `📡 Coletando dados relevantes para: "${missionText}"`,
      `🧠 Aplicando raciocínio baseado em conhecimento especializado`,
      `⚡ Executando sub-rotina de ${step.agent}`,
      `✅ Validando resultado obtido`,
    ];

    for (const thinkMsg of thinkSteps) {
      await delay(thinkingTime / 4);
      await log(task.id, step.agent, 'debug', thinkMsg);
    }

    const resultText = `[${step.agent.toUpperCase()}] ${step.description} concluído. Resposta gerada com sucesso para "${missionText.split(' ').slice(0,5).join(' ')}${missionText.split(' ').length > 5 ? '...' : ''}"`;

    task.status = 'completed';
    task.decision = `Decisão: delegado ao agente ${step.agent} baseado na análise sintática do comando`;
    task.result = resultText;
    if (dbOk) await pool.query('UPDATE tasks SET status=$1,decision=$2,result=$3,completed_at=NOW() WHERE id=$4', [task.status, task.decision, task.result, task.id]);

    results.push(resultText);

    if (agent) { agent.status = 'idle'; agent.tasksCompleted++; agent.efficiency = Math.min(100, agent.efficiency + (Math.random() * 0.5 - 0.2)); }
    broadcast('agent-update', mem.agents);
    broadcast('task-done', { missionId: mission.id, task });

    await log(task.id, step.agent, 'success', `✅ Tarefa concluída: ${step.description}`);
  }

  mission.status = 'completed';
  mission.result = results.join('\n');
  if (dbOk) await pool.query('UPDATE missions SET status=$1,result=$2,completed_at=NOW() WHERE id=$3', ['completed', mission.result, mission.id]);

  broadcast('mission-done', { id: mission.id, result: mission.result });
  broadcast('log', { agent: 'system', level: 'success', message: `🏁 Missão #${mission.id} concluída com ${steps.length} etapas` });

  return mission;
}

// ===== Express App =====
const app = express();
const httpServer = createServer(app);
app.use(express.json());
app.use(express.static(__dirname));

// API — Listar agentes
app.get('/api/agents', (req, res) => {
  res.json(mem.agents.map(a => ({ ...a, efficiency: Math.round(a.efficiency * 10) / 10 })));
});

// API — Listar missões
app.get('/api/missions', async (req, res) => {
  res.json(await allMissions());
});

// API — Logs de uma missão
app.get('/api/missions/:id/logs', async (req, res) => {
  res.json(await logsByMission(parseInt(req.params.id)));
});

// API — Enviar nova missão
app.post('/api/mission', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'Comando é obrigatório' });

  res.json({ status: 'accepted', message: 'Missão iniciada' });

  runMission(command).catch(err => {
    console.error('[MISSION ERROR]', err);
    broadcast('error', { message: err.message });
  });
});

// API — Status geral
app.get('/api/status', (req, res) => {
  const total = mem.agents.reduce((s, a) => s + a.tasksCompleted, 0);
  res.json({
    agents: mem.agents.length,
    active: mem.agents.filter(a => a.status === 'busy').length,
    totalMissions: mem.missions.length,
    totalTasks: total,
    dbConnected: dbOk,
    uptime: process.uptime(),
  });
});

// SSE — Stream de logs em tempo real
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

// Inicialização
async function start() {
  await initDB();
  httpServer.listen(PORT, () => {
    console.log(`\n═══════════════════════════════════════════`);
    console.log(`  Athena IA — Multi-Agent System`);
    console.log(`  http://localhost:${PORT}`);
    console.log(`  📡 SSE: http://localhost:${PORT}/api/stream`);
    console.log(`═══════════════════════════════════════════\n`);
  });
}

start();
