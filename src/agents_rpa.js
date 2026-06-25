import { enqueue, ROBOTS, getRPAQueue, getRPAStats, getRPALogs } from './rpa_orchestrator.js';
import { broadcast } from './orchestrator.js';
import { executeAgent } from './agents.js';
import { listLeads, updateLeadStage, recalcLeadScore, scheduleFollowUp } from './crm.js';
import { query, isDBReady } from './database.js';

// ===== Funções de automação específicas para cada Digital Worker =====

// Robô Marketing: postagens e campanhas
async function robotMarketing(task) {
  const cmd = task.input_data?.command || 'gerar relatório de campanhas de marketing';
  const result = await executeAgent('marketing', cmd, 'rpa-automation');
  return result;
}

// Robô CRM: WhatsApp, Kanban, Lead Scoring, Follow-ups autônomos
async function robotCRM(task) {
  const actions = [];

  // 1. Lead Scoring em massa
  try {
    const leads = await listLeads();
    if (leads && leads.length) {
      const pending = leads.filter(l => !l.score || l.score < 30);
      for (const lead of pending.slice(0, 5)) {
        try {
          await recalcLeadScore(lead.id);
          actions.push(`Lead #${lead.id} pontuado`);
        } catch {}
      }
    }
  } catch {}

  // 2. Follow-ups automáticos para leads parados há mais de 48h
  try {
    const now = new Date();
    const staleLeads = (leads || []).filter(l => {
      if (!l.last_contact) return false;
      const diff = (now - new Date(l.last_contact)) / (1000 * 60 * 60);
      return diff > 48 && l.stage !== 'fechado' && l.stage !== 'perdido';
    });
    for (const lead of staleLeads.slice(0, 3)) {
      try {
        await scheduleFollowUp(lead.id);
        actions.push(`Follow-up agendado para lead #${lead.id}`);
      } catch {}
    }
  } catch {}

  // 3. Mover leads engajados no pipeline
  try {
    const engaged = (leads || []).filter(l => l.stage === 'lead' && (l.interaction_count || 0) >= 3);
    for (const lead of engaged.slice(0, 3)) {
      try {
        await updateLeadStage(lead.id, 'qualificado');
        actions.push(`Lead #${lead.id} movido para Qualificado`);
      } catch {}
    }
  } catch {}

  return { output: actions.join('; ') || 'Nenhuma ação necessária' };
}

// Robô Financeiro: conciliação MP
async function robotFinanceiro(task) {
  const cmd = task.input_data?.command || 'executar conciliação financeira';
  const result = await executeAgent('financial', cmd, 'rpa-automation');

  // Log MP real se token existir
  if (process.env.MERCADO_PAGO_TOKEN) {
    try {
      const mpRes = await fetch('https://api.mercadopago.com/v1/payments/search?limit=3&sort=date_created&criteria=desc', {
        headers: { 'Authorization': `Bearer ${process.env.MERCADO_PAGO_TOKEN}` }
      });
      if (mpRes.ok) {
        const payments = await mpRes.json();
        result.mp_transactions = (payments.results || []).length;
      }
    } catch {}
  }
  return result;
}

// Robô Contábil: simulação fiscal
async function robotContabil(task) {
  const cmd = task.input_data?.command || 'simular emissão fiscal mensal';
  return executeAgent('accounting', cmd, 'rpa-automation');
}

// Robô Logística: cotações
async function robotLogistica(task) {
  const cmd = task.input_data?.command || 'realizar cotações de frete automáticas';
  return executeAgent('logistics', cmd, 'rpa-automation');
}

// Robô Jurídico: validação em lote
async function robotJuridico(task) {
  const cmd = task.input_data?.command || 'processar validações de documentos pendentes';
  return executeAgent('legal', cmd, 'rpa-automation');
}

// Robô RH: triagem
async function robotRH(task) {
  const cmd = task.input_data?.command || 'executar triagem de candidatos';
  return executeAgent('hr', cmd, 'rpa-automation');
}

// Robô Projetos: gerenciamento
async function robotProjetos(task) {
  const cmd = task.input_data?.command || 'atualizar status de projetos e tarefas';
  return executeAgent('project', cmd, 'rpa-automation');
}

// ===== Mapa de processadores =====
const PROCESSORS = {
  'robot-marketing':  robotMarketing,
  'robot-crm':        robotCRM,
  'robot-financeiro': robotFinanceiro,
  'robot-contabil':   robotContabil,
  'robot-logistica':  robotLogistica,
  'robot-juridico':   robotJuridico,
  'robot-rh':         robotRH,
  'robot-projetos':   robotProjetos,
};

// ===== API de execução direta =====
export async function executeRobotTask(robotId, taskInput) {
  const processor = PROCESSORS[robotId];
  if (!processor) throw new Error(`Robô ${robotId} não encontrado`);

  broadcast('rpa-log', { robotId, level: 'info', message: `🎯 Execução direta: ${robotId}` });

  const result = await enqueue(robotId, 'execução direta', taskInput || {}, 1);
  return result;
}

// ===== Agendamento de tarefas automáticas =====
export async function scheduleAutomatedTasks() {
  // Agendar Lead Scoring
  await enqueue('robot-crm', 'Lead Scoring em massa', { command: 'calcular lead scoring para todos os leads', source: 'rpa-automation' }, 3);
  await enqueue('robot-crm', 'Follow-ups automáticos', { command: 'disparar follow-ups para leads inativos', source: 'rpa-automation' }, 3);

  // Tarefas dos demais robôs
  await enqueue('robot-marketing', 'Relatório de campanhas', { command: 'gerar relatório automático de campanhas', source: 'rpa-automation' }, 4);

  // Operacionais (2 por vez)
  const ops = ['robot-financeiro', 'robot-logistica'];
  for (const r of ops) {
    const robot = ROBOTS.find(rb => rb.robot_id === r);
    await enqueue(r, `Rotina ${robot?.name || r}`, { command: `executar rotina automática de ${robot?.agent || r}`, source: 'rpa-automation' }, 5);
  }
}

// ===== Rotas Express =====
export function mountRPARoutes(app) {
  app.get('/api/rpa/status', async (req, res) => {
    res.json(await getRPAStats());
  });

  app.get('/api/rpa/queue', async (req, res) => {
    const limit = parseInt(req.query.limit) || 30;
    res.json(await getRPAQueue(limit));
  });

  app.get('/api/rpa/logs', async (req, res) => {
    const limit = parseInt(req.query.limit) || 50;
    res.json(await getRPALogs(limit));
  });

  app.post('/api/rpa/enqueue', async (req, res) => {
    const { robot_id, type, input_data, priority } = req.body;
    if (!robot_id || !type) return res.status(400).json({ error: 'robot_id e type obrigatórios' });
    const record = await enqueue(robot_id, type, input_data || {}, priority || 5, req.user?.tenant_uuid || null);
    res.json(record);
  });

  app.get('/api/rpa/robots', (req, res) => {
    res.json(ROBOTS);
  });
}
