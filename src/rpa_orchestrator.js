import { query, isDBReady } from './database.js';
import { broadcast } from './orchestrator.js';
import { executeAgent, getAgentStats } from './agents.js';

// ===== Robôs Registrados =====
export const ROBOTS = [
  { id:'robot-marketing',     name:'Robô Marketing',     icon:'📢', agent:'marketing',  color:'#ec4899', specialty:'Automação de postagens e campanhas' },
  { id:'robot-crm',           name:'Robô CRM',           icon:'💼', agent:'helpdesk',  color:'#f43f5e', specialty:'WhatsApp, Kanban, Lead Scoring, Follow-ups' },
  { id:'robot-financeiro',    name:'Robô Financeiro',    icon:'💰', agent:'financial', color:'#f59e0b', specialty:'Faturamento MP, conciliação' },
  { id:'robot-contabil',      name:'Robô Contábil',      icon:'📋', agent:'accounting',color:'#10b981', specialty:'NFS-e, simulação fiscal' },
  { id:'robot-logistica',     name:'Robô Logística',     icon:'📦', agent:'logistics', color:'#8b5cf6', specialty:'Cotações, rastreio' },
  { id:'robot-juridico',      name:'Robô Jurídico',      icon:'⚖️', agent:'legal',     color:'#3b82f6', specialty:'CPF/CNPJ, minutas' },
  { id:'robot-rh',            name:'Robô RH',             icon:'👤', agent:'hr',        color:'#06b6d4', specialty:'Triagem, onboarding' },
  { id:'robot-projetos',      name:'Robô Projetos',       icon:'📌', agent:'project',   color:'#14b8a6', specialty:'Tarefas ClickUp' },
];

// ===== Estados da fila =====
const STATUS = { PENDING:'pending', RUNNING:'running', SUCCESS:'success', FAILED:'failed', RETRYING:'retrying' };

// ===== Memória (fallback) =====
let memQueue = [];
let memRpaLogs = [];
let qCounter = 0;
let rpaCycle = 0;
let rpaStartTime = Date.now();
let rpaStats = { enqueued:0, processed:0, success:0, failed:0, retrying:0 };
const robotStats = {};
ROBOTS.forEach(r => { robotStats[r.id] = { processed:0, success:0, failed:0, retrying:0 }; });

// ===== Schema PostgreSQL =====
export async function ensureRPASchema() {
  if (!isDBReady()) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS rpa_queue (
        id SERIAL PRIMARY KEY, robot_id VARCHAR(50),
        type VARCHAR(100), input_data JSONB,
        status VARCHAR(20) DEFAULT 'pending',
        priority INT DEFAULT 5,
        retries INT DEFAULT 0, max_retries INT DEFAULT 3,
        error_log TEXT, result_data JSONB,
        tenant_uuid UUID,
        created_at TIMESTAMP DEFAULT NOW(),
        started_at TIMESTAMP, completed_at TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS rpa_logs (
        id SERIAL PRIMARY KEY, queue_id INT,
        robot_id VARCHAR(50), level VARCHAR(10) DEFAULT 'info',
        message TEXT, created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('[RPA] Schema verificado');
  } catch (e) { console.warn('[RPA] Schema:', e.message); }
}

// ===== Helpers =====
function now() { return new Date().toISOString(); }

async function rpaLog(queueId, robotId, level, msg) {
  const entry = { queueId, robotId, level, message: msg, created_at: now() };
  if (isDBReady()) {
    try { await query('INSERT INTO rpa_logs (queue_id,robot_id,level,message) VALUES($1,$2,$3,$4)', [queueId, robotId, level, msg]); } catch {}
  } else memRpaLogs.push(entry);
  broadcast('rpa-log', entry);
}

// ===== Enfileirar tarefa =====
export async function enqueue(robotId, type, inputData, priority = 5, tenantUuid = null) {
  const record = { robot_id: robotId, type, input_data: inputData, status: STATUS.PENDING, priority, retries: 0, max_retries: 3, error_log: null, result_data: null, tenant_uuid: tenantUuid };
  if (isDBReady()) {
    const rows = await query(
      'INSERT INTO rpa_queue (robot_id,type,input_data,status,priority,tenant_uuid) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [robotId, type, JSON.stringify(inputData), STATUS.PENDING, priority, tenantUuid]
    );
    if (rows && rows.length) { record.id = rows[0].id; record.created_at = rows[0].created_at; }
  } else {
    record.id = ++qCounter;
    record.created_at = now();
    memQueue.push(record);
  }
  rpaStats.enqueued++;
  robotStats[robotId] = robotStats[robotId] || { processed:0, success:0, failed:0, retrying:0 };
  await rpaLog(record.id, robotId, 'info', `📥 Enfileirado: ${type}`);
  broadcast('rpa-queue-update', { action:'enqueue', record });
  return record;
}

// ===== Próxima tarefa da fila =====
async function dequeue() {
  if (isDBReady()) {
    const rows = await query(
      `UPDATE rpa_queue SET status='running',started_at=NOW() WHERE id=(
        SELECT id FROM rpa_queue WHERE status='pending' ORDER BY priority DESC, created_at ASC LIMIT 1 FOR UPDATE SKIP LOCKED
      ) RETURNING *`
    );
    if (rows && rows.length) return rows[0];
  } else {
    const idx = memQueue.findIndex(q => q.status === STATUS.PENDING);
    if (idx >= 0) { const q = memQueue[idx]; q.status = STATUS.RUNNING; q.started_at = now(); return q; }
  }
  return null;
}

// ===== Marcar resultado =====
async function markResult(item, status, resultData, errorMsg) {
  if (isDBReady()) {
    await query(
      'UPDATE rpa_queue SET status=$1,result_data=$2,error_log=$3,retries=$4,completed_at=NOW() WHERE id=$5',
      [status, resultData ? JSON.stringify(resultData) : null, errorMsg, item.retries || 0, item.id]
    );
  } else {
    const q = memQueue.find(q => q.id === item.id);
    if (q) { q.status = status; q.result_data = resultData; q.error_log = errorMsg; q.completed_at = now(); }
  }
  rpaStats.processed++;
  const rs = robotStats[item.robot_id];
  if (rs) { rs.processed++; if (status === STATUS.SUCCESS) rs.success++; else if (status === STATUS.FAILED) rs.failed++; else if (status === STATUS.RETRYING) rs.retrying++; }
  if (status === STATUS.SUCCESS) rpaStats.success++;
  else if (status === STATUS.FAILED) rpaStats.failed++;
  else if (status === STATUS.RETRYING) rpaStats.retrying++;
}

// ===== Worker principal =====
async function processItem(item) {
  const robot = ROBOTS.find(r => r.robot_id === item.robot_id);
  if (!robot) { await markResult(item, STATUS.FAILED, null, 'Robô não encontrado'); return; }

  await rpaLog(item.id, item.robot_id, 'info', `🤖 ${robot.name} processando: ${item.type}`);

  try {
    const input = typeof item.input_data === 'string' ? JSON.parse(item.input_data) : (item.input_data || {});
    const command = input.command || `${item.type}: ${JSON.stringify(input).slice(0, 100)}`;
    const source = input.source || 'rpa';

    const result = await executeAgent(robot.agent, command, source);

    if (result.status === 'success') {
      await markResult(item, STATUS.SUCCESS, { output: result.output }, null);
      await rpaLog(item.id, item.robot_id, 'success', `✅ ${robot.name}: ${item.type} concluído`);
    } else {
      throw new Error(result.output || 'Erro desconhecido');
    }
  } catch (err) {
    const retries = (item.retries || 0) + 1;
    if (retries < (item.max_retries || 3)) {
      await markResult(item, STATUS.RETRYING, null, `Tentativa ${retries}: ${err.message}`);
      await rpaLog(item.id, item.robot_id, 'warn', `🔄 Retentativa ${retries}/${item.max_retries}: ${err.message.slice(0, 100)}`);

      if (isDBReady()) await query('UPDATE rpa_queue SET retries=$1,error_log=$2 WHERE id=$3', [retries, `Tentativa ${retries}: ${err.message}`, item.id]);
      else { const q = memQueue.find(q => q.id === item.id); if (q) { q.retries = retries; q.error_log = `Tentativa ${retries}: ${err.message}`; q.status = STATUS.PENDING; } }

      await rpaLog(item.id, item.robot_id, 'info', `🔄 Re-enfileirado para retentativa ${retries}/${item.max_retries}`);
      broadcast('rpa-queue-update', { action:'retry', itemId: item.id, retries });
    } else {
      await markResult(item, STATUS.FAILED, null, `Final após ${retries} tentativas: ${err.message}`);
      await rpaLog(item.id, item.robot_id, 'error', `❌ ${robot.name}: falha após ${retries} tentativas — ${err.message.slice(0, 150)}`);
    }
  }
}

// ===== Tarefas automáticas de RPA (geradas a cada ciclo) =====
async function generateAutoTasks() {
  if (rpaCycle % 6 === 0) {
    await enqueue('robot-crm', 'Lead Scoring em massa', { command: 'calcular lead scoring para todos os leads pendentes', source: 'rpa' }, 3);
  }
  if (rpaCycle % 12 === 0) {
    await enqueue('robot-marketing', 'Verificação de campanhas', { command: 'verificar métricas de campanhas de marketing', source: 'rpa' }, 4);
    await enqueue('robot-financeiro', 'Conciliação automática', { command: 'executar conciliação financeira com Mercado Pago', source: 'rpa' }, 4);
  }
  if (rpaCycle % 24 === 0) {
    const agents = ['robot-logistica', 'robot-contabil', 'robot-juridico', 'robot-rh', 'robot-projetos'];
    for (const a of agents) {
      const robot = ROBOTS.find(r => r.robot_id === a);
      await enqueue(a, `Rotina automática ${robot?.agent || a}`, { command: `executar rotina de manutenção do setor ${robot?.agent || a}`, source: 'rpa' }, 5);
    }
  }
}

// ===== Motor RPA 24/7 =====
let rpaInterval = null;
let processing = false;

export function startRPAEngine() {
  console.log('[RPA] Motor iniciado');
  rpaCycle = 0;

  rpaInterval = setInterval(async () => {
    try {
      rpaCycle++;

      // Auto-tasks
      if (rpaCycle % 3 === 0) await generateAutoTasks();

      // Processar fila (um item por ciclo, para não travar)
      const item = await dequeue();
      if (item) {
        processing = true;
        await processItem(item).catch(e => console.error('[RPA] Worker error:', e.message));
        processing = false;
      }

      // Heartbeat a cada 10 ciclos
      if (rpaCycle % 10 === 0) {
        broadcast('rpa-heartbeat', {
          cycle: rpaCycle, uptime: Math.floor((Date.now() - rpaStartTime) / 1000),
          stats: { ...rpaStats },
          robotStats: Object.fromEntries(Object.entries(robotStats).map(([k, v]) => [k, { ...v }])),
        });
      }

      // Health check do DB
      if (rpaCycle % 30 === 0 && isDBReady()) {
        try { await query('SELECT 1'); } catch { /* reconnect handled by pool */ }
      }
    } catch (err) {
      console.error('[RPA] Engine error:', err.message);
    }
  }, 8000);
}

export function stopRPAEngine() { if (rpaInterval) clearInterval(rpaInterval); }

// ===== Consultas =====
export async function getRPAStats() {
  let dbStats = null;
  if (isDBReady()) {
    const rows = await query(`
      SELECT status, COUNT(*) as count FROM rpa_queue GROUP BY status
    `);
    if (rows) {
      dbStats = { pending:0, running:0, success:0, failed:0, retrying:0, total:0 };
      rows.forEach(r => { dbStats[r.status] = parseInt(r.count); dbStats.total += parseInt(r.count); });
    }
  }
  return {
    memory: { ...rpaStats, cycle: rpaCycle, uptime: Math.floor((Date.now() - rpaStartTime) / 1000) },
    database: dbStats,
    robotStats: Object.fromEntries(Object.entries(robotStats).map(([k, v]) => [k, { ...v }])),
    robots: ROBOTS.map(r => ({ ...r, stats: robotStats[r.id] || { processed:0, success:0, failed:0, retrying:0 } })),
  };
}

export async function getRPAQueue(limit = 50) {
  if (isDBReady()) {
    const rows = await query('SELECT * FROM rpa_queue ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows || [];
  }
  return [...memQueue].reverse().slice(0, limit);
}

export async function getRPALogs(limit = 100) {
  if (isDBReady()) {
    const rows = await query('SELECT * FROM rpa_logs ORDER BY created_at DESC LIMIT $1', [limit]);
    return rows || [];
  }
  return [...memRpaLogs].reverse().slice(0, limit);
}
