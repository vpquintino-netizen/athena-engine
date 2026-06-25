import { query } from './database.js';
import { processWithAI } from './ai.js';
import { broadcast } from './orchestrator.js';

// ===== Estados do Pipeline =====
export const PIPELINE_STAGES = [
  { id: 'lead',         label: 'Lead',          color: '#8b5cf6', icon: '🆕' },
  { id: 'qualificado',  label: 'Qualificado',    color: '#3b82f6', icon: '✅' },
  { id: 'negociacao',   label: 'Negociação',     color: '#f59e0b', icon: '🤝' },
  { id: 'proposta',     label: 'Proposta',       color: '#ec4899', icon: '📄' },
  { id: 'fechado',      label: 'Fechado',        color: '#10b981', icon: '🎉' },
  { id: 'perdido',      label: 'Perdido',        color: '#6b7280', icon: '❌' },
];

const PIPELINE_MAP = {};
PIPELINE_STAGES.forEach(s => { PIPELINE_MAP[s.id] = s; });

// ===== Lead Scoring: IA analisa e atribui nota =====
async function calculateLeadScore(lead) {
  const profile = {
    email: lead.email || '',
    name: lead.name || '',
    source: lead.source || '',
    interactions: lead.interactionCount || 0,
    lastContact: lead.lastContact || '',
    messageCount: lead.messageCount || 0,
    origin: lead.origin || '',
  };

  const prompt = `Analise este lead comercial e atribua uma nota de 0 a 100 (apenas o número) com base em:
- Fonte de origem (maior peso para indicação e orgânico)
- Número de interações (mais = mais engajado)
- Recência do último contato (recente = maior score)
- Potencial percebido

Lead: ${JSON.stringify(profile)}

Responda APENAS com o número inteiro da nota:`;

  let score = 50;
  try {
    const result = await processWithAI('marketing', prompt, 50);
    const parsed = parseInt(result?.replace(/\D/g, ''));
    if (parsed && parsed >= 0 && parsed <= 100) score = parsed;
  } catch {}

  // Bônus baseado em regras
  if (lead.interactionCount > 5) score += 10;
  if (lead.origin === 'indicacao') score += 15;
  if (lead.origin === 'whatsapp') score += 5;
  if (lead.source === 'instagram' || lead.source === 'facebook') score += 3;

  return Math.min(100, Math.max(0, score));
}

// ===== Follow-up Autônomo =====
async function generateFollowUp(lead) {
  const prompt = `Crie uma mensagem de follow-up personalizada e profissional (máximo 3 parágrafos) para um lead do CRM.
Lead: ${lead.name || 'Cliente'}
Origem: ${lead.source || 'desconhecida'}
Pipeline: ${lead.stage || 'lead'}
Interações anteriores: ${lead.interactionCount || 0}

A mensagem deve ser educada, oferecer valor e tentar quebrar objeções sem ser invasiva.
Use português natural. Retorne APENAS o texto da mensagem.`;

  let message = '';
  try {
    message = await processWithAI('marketing', prompt, 300);
  } catch {}

  if (!message || message.length < 20) {
    message = `Olá ${lead.name || 'tudo bem'}! 👋\n\nPassando aqui para saber se posso ajudar em algo. Nosso time está disponível para esclarecer dúvidas sobre como a Athena IA pode transformar a operação do seu negócio com hiperautomação multi-agentes.\n\nSe preferir, é só responder esta mensagem. Ficarei feliz em ajudar! 🚀`;
  }

  return message;
}

// ===== Schema PostgreSQL =====
export async function ensureCRMSchema() {
  if (!process.env.DATABASE_URL) return;
  try {
    await query(`
      CREATE TABLE IF NOT EXISTS crm_leads (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255), email VARCHAR(255), phone VARCHAR(50),
        company VARCHAR(255), source VARCHAR(50), origin VARCHAR(50),
        stage VARCHAR(30) DEFAULT 'lead',
        score INT DEFAULT 50,
        interaction_count INT DEFAULT 0,
        message_count INT DEFAULT 0,
        last_contact TIMESTAMP,
        notes TEXT,
        social_profile JSONB,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS crm_interactions (
        id SERIAL PRIMARY KEY,
        lead_id INT REFERENCES crm_leads(id),
        type VARCHAR(30), channel VARCHAR(30),
        content TEXT, direction VARCHAR(10),
        agent VARCHAR(50), metadata JSONB,
        created_at TIMESTAMP DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS crm_follow_ups (
        id SERIAL PRIMARY KEY,
        lead_id INT REFERENCES crm_leads(id),
        message TEXT, status VARCHAR(20) DEFAULT 'pending',
        scheduled_for TIMESTAMP,
        sent_at TIMESTAMP, response TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);
    console.log('[CRM] Schema verificado');
  } catch (e) {
    console.warn('[CRM] Schema error:', e.message);
  }
}

// ===== API Interna =====
let memLeads = [];
let memInteractions = [];
let memFollowUps = [];
let leadIdCounter = 0;

// --- Leads ---
export async function listLeads() {
  if (process.env.DATABASE_URL) {
    const rows = await query('SELECT * FROM crm_leads ORDER BY updated_at DESC');
    if (rows) return rows;
  }
  return memLeads;
}

export async function getLead(id) {
  if (process.env.DATABASE_URL) {
    const rows = await query('SELECT * FROM crm_leads WHERE id=$1', [id]);
    if (rows && rows.length) return rows[0];
  }
  return memLeads.find(l => l.id === id);
}

export async function createLead(data) {
  const score = await calculateLeadScore(data);
  const record = {
    name: data.name || '',
    email: data.email || '',
    phone: data.phone || '',
    company: data.company || '',
    source: data.source || 'manual',
    origin: data.origin || 'manual',
    stage: 'lead',
    score,
    interactionCount: 0,
    messageCount: 0,
    notes: data.notes || '',
    socialProfile: data.socialProfile || {},
  };

  if (process.env.DATABASE_URL) {
    const rows = await query(
      `INSERT INTO crm_leads (name,email,phone,company,source,origin,stage,score,notes,social_profile)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [record.name, record.email, record.phone, record.company, record.source, record.origin,
       record.stage, record.score, record.notes, JSON.stringify(record.socialProfile)]
    );
    if (rows && rows.length) {
      const lead = rows[0];
      broadcast('crm-update', { type: 'lead-created', lead });
      return lead;
    }
  }

  record.id = ++leadIdCounter;
  record.createdAt = new Date().toISOString();
  record.updatedAt = record.createdAt;
  memLeads.unshift(record);
  broadcast('crm-update', { type: 'lead-created', lead: record });
  return record;
}

export async function updateLeadStage(id, stage) {
  if (!PIPELINE_MAP[stage]) throw new Error(`Estágio inválido: ${stage}`);
  if (process.env.DATABASE_URL) {
    const rows = await query('UPDATE crm_leads SET stage=$1,updated_at=NOW() WHERE id=$2 RETURNING *', [stage, id]);
    if (rows && rows.length) {
      broadcast('crm-update', { type: 'lead-moved', lead: rows[0], stage });
      return rows[0];
    }
  }
  const lead = memLeads.find(l => l.id === id);
  if (lead) { lead.stage = stage; lead.updatedAt = new Date().toISOString(); broadcast('crm-update', { type: 'lead-moved', lead, stage }); }
  return lead;
}

export async function recalcLeadScore(id) {
  const lead = await getLead(id);
  if (!lead) return null;
  lead.score = await calculateLeadScore(lead);
  if (process.env.DATABASE_URL) {
    await query('UPDATE crm_leads SET score=$1,updated_at=NOW() WHERE id=$2', [lead.score, id]);
  }
  broadcast('crm-update', { type: 'lead-scored', id, score: lead.score });
  return lead;
}

// --- Interações ---
export async function addInteraction(leadId, data) {
  const record = {
    leadId, type: data.type || 'message', channel: data.channel || 'manual',
    content: data.content || '', direction: data.direction || 'inbound',
    agent: data.agent || '', metadata: data.metadata || {},
  };
  if (process.env.DATABASE_URL) {
    const rows = await query(
      `INSERT INTO crm_interactions (lead_id,type,channel,content,direction,agent,metadata)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [record.leadId, record.type, record.channel, record.content, record.direction, record.agent, JSON.stringify(record.metadata)]
    );
    if (rows && rows.length) {
      await query('UPDATE crm_leads SET interaction_count=interaction_count+1,last_contact=NOW(),updated_at=NOW() WHERE id=$1', [leadId]);
      broadcast('crm-update', { type: 'interaction', interaction: rows[0] });
      return rows[0];
    }
  }
  record.id = memInteractions.length + 1;
  record.createdAt = new Date().toISOString();
  memInteractions.unshift(record);
  const lead = memLeads.find(l => l.id === leadId);
  if (lead) { lead.interactionCount++; lead.lastContact = record.createdAt; lead.updatedAt = record.createdAt; }
  broadcast('crm-update', { type: 'interaction', interaction: record });
  return record;
}

export async function getInteractions(leadId) {
  if (process.env.DATABASE_URL) {
    const rows = await query('SELECT * FROM crm_interactions WHERE lead_id=$1 ORDER BY created_at DESC', [leadId]);
    if (rows) return rows;
  }
  return memInteractions.filter(i => i.leadId === leadId);
}

// --- Follow-ups Autônomos ---
export async function scheduleFollowUp(leadId) {
  const lead = await getLead(leadId);
  if (!lead) return null;

  const message = await generateFollowUp(lead);
  const scheduledFor = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24h

  if (process.env.DATABASE_URL) {
    const rows = await query(
      'INSERT INTO crm_follow_ups (lead_id,message,scheduled_for) VALUES($1,$2,$3) RETURNING *',
      [leadId, message, scheduledFor]
    );
    if (rows && rows.length) {
      broadcast('crm-update', { type: 'followup-scheduled', followUp: rows[0] });
      return rows[0];
    }
  }

  const fu = { id: memFollowUps.length + 1, leadId, message, status: 'pending', scheduledFor: scheduledFor.toISOString() };
  memFollowUps.push(fu);
  broadcast('crm-update', { type: 'followup-scheduled', followUp: fu });
  return fu;
}

export async function getFollowUps(leadId) {
  if (process.env.DATABASE_URL) {
    const rows = await query('SELECT * FROM crm_follow_ups WHERE lead_id=$1 ORDER BY created_at DESC', [leadId]);
    if (rows) return rows;
  }
  return memFollowUps.filter(f => f.leadId === leadId);
}

// ===== Motor de Follow-up Automático =====
let followUpInterval = null;

export function startFollowUpEngine() {
  console.log('[CRM] Motor de follow-ups iniciado');
  followUpInterval = setInterval(async () => {
    try {
      const now = new Date();
      let pending;

      if (process.env.DATABASE_URL) {
        pending = await query(
          `SELECT f.*, l.name as lead_name, l.email as lead_email, l.phone as lead_phone
           FROM crm_follow_ups f JOIN crm_leads l ON f.lead_id=l.id
           WHERE f.status='pending' AND f.scheduled_for <= NOW()`
        );
      } else {
        pending = memFollowUps
          .filter(f => f.status === 'pending' && new Date(f.scheduledFor) <= now)
          .map(f => ({ ...f, lead_name: memLeads.find(l => l.id === f.leadId)?.name }));
      }

      if (pending && pending.length) {
        for (const fu of pending) {
          broadcast('log', { agent: 'crm', level: 'info', message: `📬 Follow-up autônomo disparado para ${fu.lead_name || 'lead #' + fu.lead_id}: "${fu.message?.slice(0, 60)}..."` });

          if (process.env.DATABASE_URL) {
            await query('UPDATE crm_follow_ups SET status=$1,sent_at=NOW() WHERE id=$2', ['sent', fu.id]);
          } else {
            const mfu = memFollowUps.find(f => f.id === fu.id);
            if (mfu) { mfu.status = 'sent'; mfu.sentAt = new Date().toISOString(); }
          }

          await addInteraction(fu.lead_id, {
            type: 'followup', channel: 'email',
            content: fu.message, direction: 'outbound',
            agent: 'crm',
          });

          broadcast('crm-update', { type: 'followup-sent', followUp: fu });
        }
      }
    } catch (err) {
      console.error('[CRM FOLLOWUP] Error:', err.message);
    }
  }, 30000);
}

// ===== Pipeline Stats =====
export async function getPipelineStats() {
  const stages = {};
  PIPELINE_STAGES.forEach(s => { stages[s.id] = { label: s.label, count: 0, leads: [], totalScore: 0 }; });

  const leads = await listLeads();
  leads.forEach(l => {
    const stage = l.stage || 'lead';
    if (stages[stage]) {
      stages[stage].count++;
      stages[stage].leads.push(l);
      stages[stage].totalScore += l.score || 0;
    }
  });

  return PIPELINE_STAGES.map(s => ({
    ...s,
    count: stages[s.id]?.count || 0,
    avgScore: stages[s.id]?.count > 0 ? Math.round(stages[s.id].totalScore / stages[s.id].count) : 0,
  }));
}
