import { broadcast } from './orchestrator.js';
import { runMission } from './orchestrator.js';
import { createLead, addInteraction } from './crm.js';

// ===== Roteador de Webhooks para 7 Redes Sociais =====
// Cada plataforma tem seu formato específico — normalizamos para o formato interno

const PLATFORMS = {
  whatsapp:  { name: 'WhatsApp',  icon: '💬', color: '#25D366' },
  instagram: { name: 'Instagram', icon: '📸', color: '#E4405F' },
  facebook:  { name: 'Facebook',  icon: '👍', color: '#1877F2' },
  tiktok:    { name: 'TikTok',    icon: '🎵', color: '#000000' },
  linkedin:  { name: 'LinkedIn',  icon: '💼', color: '#0A66C2' },
  telegram:  { name: 'Telegram',  icon: '✈️', color: '#26A5E4' },
  x:         { name: 'X / Twitter', icon: '🐦', color: '#1DA1F2' },
};

export { PLATFORMS };

// ===== Normalizador de Mensagens =====
function normalizeMessage(platform, raw) {
  const base = {
    platform,
    fromId: '',
    fromName: '',
    message: '',
    timestamp: new Date().toISOString(),
    raw,
  };

  switch (platform) {
    case 'whatsapp':
      base.fromId = raw.from || raw.waId || raw.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.wa_id || '';
      base.fromName = raw.profileName || raw.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name || '';
      base.message = raw.text?.body || raw.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body || '';
      break;
    case 'instagram':
      base.fromId = raw.sender?.id || raw.from?.id || raw.entry?.[0]?.messaging?.[0]?.sender?.id || '';
      base.fromName = raw.sender?.name || raw.from?.name || '';
      base.message = raw.message?.text || raw.entry?.[0]?.messaging?.[0]?.message?.text || '';
      break;
    case 'facebook':
      base.fromId = raw.sender?.id || raw.entry?.[0]?.messaging?.[0]?.sender?.id || '';
      base.fromName = raw.sender?.name || '';
      base.message = raw.message?.text || raw.entry?.[0]?.messaging?.[0]?.message?.text || '';
      break;
    case 'tiktok':
      base.fromId = raw.from_user_id || raw.sender?.open_id || '';
      base.fromName = raw.from_username || raw.sender?.nickname || '';
      base.message = raw.content || raw.text || raw.message?.text || '';
      break;
    case 'linkedin':
      base.fromId = raw.from?.id || raw.sender?.id || raw.event?.from?.id || '';
      base.fromName = raw.from?.name || raw.sender?.name || raw.event?.from?.firstName + ' ' + (raw.event?.from?.lastName || '') || '';
      base.message = raw.content || raw.message?.text || raw.event?.content || '';
      break;
    case 'telegram':
      base.fromId = String(raw.message?.from?.id || raw.callback_query?.from?.id || raw.from?.id || '');
      base.fromName = raw.message?.from?.first_name + ' ' + (raw.message?.from?.last_name || '') || raw.from?.first_name || '';
      base.message = raw.message?.text || raw.callback_query?.data || '';
      break;
    case 'x':
    case 'twitter':
      base.fromId = raw.dm?.sender_id || raw.user_id || raw.user?.id || raw.direct_message?.sender_id || '';
      base.fromName = raw.dm?.sender_screen_name || raw.user?.screen_name || raw.user?.name || raw.direct_message?.sender_screen_name || '';
      base.message = raw.dm?.text || raw.text || raw.tweet_text || raw.direct_message?.text || '';
      break;
  }

  return base;
}

// ===== Processamento de mensagem recebida =====
async function processIncoming(platform, raw, req) {
  const msg = normalizeMessage(platform, raw);
  if (!msg.message || !msg.message.trim()) return null;

  broadcast('log', {
    agent: platform,
    level: 'info',
    message: `📩 Mensagem recebida via ${PLATFORMS[platform]?.name || platform}: "${msg.message.slice(0, 80)}..." de ${msg.fromName || msg.fromId}`,
  });

  // Alimenta o CRM
  try {
    const lead = await createLead({
      name: msg.fromName || `Usuário ${platform}`,
      source: platform,
      origin: platform,
      email: `${msg.fromId}@${platform}.social`,
      socialProfile: { platform, id: msg.fromId, name: msg.fromName },
    });

    await addInteraction(lead.id, {
      type: 'message',
      channel: platform,
      content: msg.message,
      direction: 'inbound',
      agent: platform,
      metadata: { platform, fromId: msg.fromId },
    });
  } catch (e) {
    console.error(`[SOCIAL] CRM error:`, e.message);
  }

  // Direciona ao orquestrador para processamento
  const cmd = `[${platform.toUpperCase()}] ${msg.fromName || msg.fromId}: "${msg.message}"`;
  runMission(cmd, platform).catch(err => {
    broadcast('error', { message: `Erro processando mensagem de ${platform}: ${err.message}` });
  });

  return msg;
}

// ===== Webhook Handlers =====

// WhatsApp Cloud API — Verificação do webhook
export function handleWhatsAppVerify(req, res) {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === (process.env.WHATSAPP_VERIFY_TOKEN || 'athena_webhook_2024')) {
    console.log('[WHATSAPP] Webhook verificado');
    return res.status(200).send(challenge);
  }
  res.status(403).send('Verificação falhou');
}

// WhatsApp Cloud API — Recebimento de mensagens
export async function handleWhatsAppWebhook(req, res) {
  try {
    const entry = req.body?.entry;
    if (entry) {
      for (const e of entry) {
        const changes = e.changes || [];
        for (const c of changes) {
          if (c.value?.messages) {
            for (const m of c.value.messages) {
              await processIncoming('whatsapp', {
                from: m.from,
                text: { body: m.text?.body || '' },
                profileName: c.value.contacts?.[0]?.profile?.name || '',
                waId: m.from,
              });
            }
          }
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[WHATSAPP] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// Instagram / Facebook
export async function handleInstagramWebhook(req, res) {
  try {
    if (req.body?.entry) {
      for (const e of req.body.entry) {
        if (e.messaging) {
          for (const m of e.messaging) {
            if (m.message?.text) {
              await processIncoming('instagram', {
                sender: { id: m.sender?.id },
                message: { text: m.message.text },
              });
            }
          }
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[INSTAGRAM] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

export async function handleFacebookWebhook(req, res) {
  try {
    if (req.body?.entry) {
      for (const e of req.body.entry) {
        if (e.messaging) {
          for (const m of e.messaging) {
            if (m.message?.text) {
              await processIncoming('facebook', {
                sender: { id: m.sender?.id },
                message: { text: m.message.text },
              });
            }
          }
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[FACEBOOK] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// TikTok
export async function handleTikTokWebhook(req, res) {
  try {
    const body = req.body;
    if (body.content) {
      await processIncoming('tiktok', {
        from_user_id: body.from_user_id || body.open_id,
        from_username: body.from_username || body.nickname,
        content: body.content,
      });
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[TIKTOK] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// LinkedIn
export async function handleLinkedInWebhook(req, res) {
  try {
    const body = req.body;
    if (body.content || body.message?.text) {
      await processIncoming('linkedin', body);
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[LINKEDIN] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// Telegram
export async function handleTelegramWebhook(req, res) {
  try {
    const body = req.body;
    if (body.message?.text) {
      await processIncoming('telegram', body);
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[TELEGRAM] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// X / Twitter
export async function handleXWebhook(req, res) {
  try {
    // Twitter CRC (CRC — consume response challenge)
    const crcToken = req.query?.crc_token;
    if (crcToken) {
      const crypto = await import('crypto');
      const hash = crypto.createHmac('sha256', process.env.X_WEBHOOK_SECRET || 'athena_secret')
        .update(crcToken).digest('base64');
      return res.json({ response_token: `sha256=${hash}` });
    }

    const body = req.body;
    if (body.dm?.text || body.direct_message?.text) {
      await processIncoming('x', body);
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[X] Error:', err.message);
    res.status(200).json({ status: 'ok' });
  }
}

// ===== Rotas Express =====
export function mountSocialRoutes(app) {
  // WhatsApp
  app.get('/webhooks/whatsapp', handleWhatsAppVerify);
  app.post('/webhooks/whatsapp', handleWhatsAppWebhook);

  // Instagram
  app.get('/webhooks/instagram', (req, res) => {
    if (req.query['hub.challenge']) return res.send(req.query['hub.challenge']);
    res.send('ok');
  });
  app.post('/webhooks/instagram', handleInstagramWebhook);

  // Facebook
  app.get('/webhooks/facebook', (req, res) => {
    if (req.query['hub.challenge']) return res.send(req.query['hub.challenge']);
    res.send('ok');
  });
  app.post('/webhooks/facebook', handleFacebookWebhook);

  // TikTok
  app.post('/webhooks/tiktok', handleTikTokWebhook);

  // LinkedIn
  app.post('/webhooks/linkedin', handleLinkedInWebhook);

  // Telegram
  app.post('/webhooks/telegram', handleTelegramWebhook);

  // X / Twitter
  app.get('/webhooks/x', handleXWebhook);
  app.post('/webhooks/x', handleXWebhook);

  // Webhook status info
  app.get('/api/webhooks/status', (req, res) => {
    res.json({
      platforms: Object.entries(PLATFORMS).map(([id, p]) => ({
        id, name: p.name, icon: p.icon, color: p.color,
        webhookUrl: `/webhooks/${id}`,
        configured: true,
      }))
    });
  });
}
