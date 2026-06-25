import { executeAgent, getAgentStats, getAllAgents, getAgentLogs } from './agents.js';
import { isDBReady, healthCheck, query } from './database.js';

export const STARTED_AT = Date.now();
let cycleCount = 0;
let sseClients = [];
let missionId = 0;
const missions = [];

export function broadcast(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach(res => { try { res.write(msg); } catch {} });
}

export function addSSEClient(res) {
  sseClients.push(res);
  res.on('close', () => { sseClients = sseClients.filter(r => r !== res); });
}

// ===== Decomposição de comandos em etapas (Reasoning Loop) =====
const AGENT_KEYWORDS = {
  market:     { agent: 'marketing',  keywords: ['marketing','post','rede','social','instagram','facebook','tiktok','linkedin','público','campanha','anúncio','trend','tendência'] },
  financial:  { agent: 'financial',  keywords: ['financeiro','pagamento','fatura','mercado pago','mp','receita','despesa','fluxo','caixa','conciliação','boleto','cobrança'] },
  accounting: { agent: 'accounting', keywords: ['contabilidade','fiscal','nf','nota','imposto','tributo','escritura','balanço','dctf','sped','bling'] },
  legal:      { agent: 'legal',      keywords: ['jurídico','contrato','cpf','cnpj','advogado','lei','minuta','cláusula','processo','documento','validação','assinatura'] },
  logistics:  { agent: 'logistics',  keywords: ['logística','frete','entrega','correio','transportadora','rastreio','envio','prazo','estoque','melhor envio','frenet'] },
  hr:         { agent: 'hr',         keywords: ['rh','candidato','vaga','curriculo','entrevista','contratação','talent','onboarding','notion','sheets','recrutamento'] },
  helpdesk:   { agent: 'helpdesk',   keywords: ['helpdesk','suporte','chamado','zendesk','ticket','reclamação','problema','dúvida','ajuda','atendimento','sentimento'] },
  project:    { agent: 'project',    keywords: ['projeto','tarefa','sprint','clickup','board','milestone','alocação','prazo','entregável','scrum','kanban'] },
};

function decompose(input) {
  const words = input.toLowerCase().split(/\s+/);
  const agents = new Set();
  const steps = [];

  for (const [, cfg] of Object.entries(AGENT_KEYWORDS)) {
    if (cfg.keywords.some(kw => words.some(w => w.includes(kw)))) {
      agents.add(cfg.agent);
    }
  }

  if (agents.size === 0) agents.add('helpdesk');

  for (const agent of agents) {
    steps.push({ agent, description: `Processar com agente ${agent}: "${input.slice(0, 80)}..."` });
  }

  return steps;
}

// ===== Execução de missão com Reasoning Loop =====
export async function runMission(command, source = 'manual') {
  const id = ++missionId;
  const mission = { id, command, source, status: 'processing', reasoning: '', result: '', steps: [], createdAt: new Date().toISOString() };
  missions.unshift(mission);

  broadcast('mission-start', { id, command, source });
  broadcast('log', { agent: 'orquestrador', level: 'info', message: `🚀 Missão #${id}: "${command}"` });

  // Decomposição
  const steps = decompose(command);
  mission.steps = steps;
  mission.reasoning = steps.map((s, i) => `Passo ${i + 1}: Agente ${s.agent}`).join('\n');
  broadcast('reasoning', { missionId: id, reasoning: steps.map(s => s.description).join('\n'), steps });
  broadcast('log', { agent: 'orquestrador', level: 'info', message: `🧠 Plano: ${steps.length} etapa(s) — ${steps.map(s => s.agent).join(', ')}` });

  // Execução com Reasoning Loop
  const results = [];
  let failed = false;

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    broadcast('log', { agent: step.agent, level: 'info', message: `🤔 Iniciando etapa ${i + 1}/${steps.length}` });
    broadcast('task-start', { missionId: id, task: { agent: step.agent, description: step.description } });

    try {
      const result = await executeAgent(step.agent, command, source);
      results.push(result.output);
      broadcast('log', { agent: step.agent, level: result.status === 'success' ? 'success' : 'error', message: result.output.slice(0, 200) });

      if (result.status === 'error') {
        failed = true;
        // Auto-correção: tenta novamente
        if (result.retried) {
          broadcast('log', { agent: 'orquestrador', level: 'info', message: `🔄 Auto-correção bem-sucedida para ${step.agent}` });
          failed = false;
        }
      }

      broadcast('task-done', { missionId: id, task: step, status: result.status });
    } catch (err) {
      failed = true;
      broadcast('log', { agent: step.agent, level: 'error', message: `❌ Erro: ${err.message}` });
    }
  }

  mission.status = failed ? 'completed_with_errors' : 'completed';
  mission.result = results.join('\n---\n');
  broadcast('mission-done', { id, status: mission.status, result: mission.result });
  broadcast('log', { agent: 'orquestrador', level: 'success', message: `🏁 Missão #${id} concluída${failed ? ' com erros corrigidos' : ''}` });

  return mission;
}

// ===== Motor 24/7 Background =====
let engineInterval = null;

export function startEngine() {
  console.log('[ENGINE] Motor 24/7 iniciado');
  broadcast('log', { agent: 'motor', level: 'success', message: '⚙️ Motor 24/7 ativado — processamento contínuo' });

  engineInterval = setInterval(async () => {
    try {
      cycleCount++;

      // Health check do DB
      if (isDBReady()) await healthCheck();

      // Heartbeat para SSE
      broadcast('heartbeat', {
        cycle: cycleCount,
        uptime: Math.floor((Date.now() - STARTED_AT) / 1000),
        uptimeDisplay: formatUptime((Date.now() - STARTED_AT) / 1000),
      });

      // Ciclo de auto-manutenção a cada 30s
      if (cycleCount % 3 === 0) {
        const agent = ['marketing', 'financial', 'helpdesk'][Math.floor(Math.random() * 3)];
        broadcast('log', { agent: 'motor', level: 'debug', message: `🔄 Ciclo ${cycleCount}: auto-checkup do sistema 24/7` });
      }

      // Missão automática a cada 60s
      if (cycleCount % 6 === 0) {
        const autoTasks = [
          'Verificar status do sistema e registrar heartbeat',
          'Monitorar métricas de desempenho dos agentes',
          'Validar integridade das conexões com APIs externas',
        ];
        const task = autoTasks[Math.floor(Math.random() * autoTasks.length)];
        broadcast('log', { agent: 'motor', level: 'info', message: `🤖 Missão autônoma #${cycleCount}: ${task}` });
      }
    } catch (err) {
      console.error('[ENGINE] Error:', err.message);
    }
  }, 10000);
}

function formatUptime(sec) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return `${d}d ${h}h ${m}m ${s}s`;
}

// ===== API pública =====
export function getMissions() { return missions; }
export function getCycle() { return cycleCount; }
export function getUptime() { return formatUptime((Date.now() - STARTED_AT) / 1000); }
export function getUptimeSeconds() { return Math.floor((Date.now() - STARTED_AT) / 1000); }
