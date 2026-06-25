import crypto from 'crypto';

// ===== Configuração OAuth2 para cada plataforma =====
const OAUTH_CONFIG = {
  whatsapp: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: ['whatsapp_business_messaging', 'whatsapp_business_profile'],
    clientId: process.env.WHATSAPP_CLIENT_ID || '',
    clientSecret: process.env.WHATSAPP_CLIENT_SECRET || '',
  },
  instagram: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: ['instagram_basic', 'instagram_manage_messages', 'pages_show_list'],
    clientId: process.env.INSTAGRAM_CLIENT_ID || '',
    clientSecret: process.env.INSTAGRAM_CLIENT_SECRET || '',
  },
  facebook: {
    authUrl: 'https://www.facebook.com/v18.0/dialog/oauth',
    tokenUrl: 'https://graph.facebook.com/v18.0/oauth/access_token',
    scopes: ['pages_manage_metadata', 'pages_messaging', 'pages_read_engagement'],
    clientId: process.env.FACEBOOK_CLIENT_ID || '',
    clientSecret: process.env.FACEBOOK_CLIENT_SECRET || '',
  },
  tiktok: {
    authUrl: 'https://www.tiktok.com/v2/auth/authorize/',
    tokenUrl: 'https://open.tiktokapis.com/v2/oauth/token/',
    scopes: ['user.info.basic', 'video.upload', 'message.send'],
    clientId: process.env.TIKTOK_CLIENT_KEY || '',
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || '',
  },
  linkedin: {
    authUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: ['w_member_social', 'r_liteprofile', 'r_emailaddress'],
    clientId: process.env.LINKEDIN_CLIENT_ID || '',
    clientSecret: process.env.LINKEDIN_CLIENT_SECRET || '',
  },
  telegram: {
    authUrl: `https://t.me/bot${process.env.TELEGRAM_BOT_TOKEN || ''}`,
    scopes: [],
    clientId: process.env.TELEGRAM_BOT_TOKEN || '',
    botUsername: process.env.TELEGRAM_BOT_USERNAME || 'AthenaIA_Bot',
  },
  x: {
    authUrl: 'https://twitter.com/i/oauth2/authorize',
    tokenUrl: 'https://api.twitter.com/2/oauth2/token',
    scopes: ['tweet.read', 'tweet.write', 'dm.read', 'dm.write', 'users.read', 'offline.access'],
    clientId: process.env.X_CLIENT_ID || '',
    clientSecret: process.env.X_CLIENT_SECRET || '',
  },
};

// ===== Armazenamento de Tokens =====
let tokenStore = {};

function storeTokens(platform, tokens) {
  tokenStore[platform] = {
    ...tokens,
    storedAt: new Date().toISOString(),
  };
}

export function getStoredTokens(platform) {
  return tokenStore[platform] || null;
}

export function getAllConnections() {
  return Object.entries(OAUTH_CONFIG).map(([id, cfg]) => ({
    id,
    name: id.charAt(0).toUpperCase() + id.slice(1),
    connected: !!tokenStore[id],
    configured: !!(cfg.clientId || cfg.clientSecret || cfg.botUsername),
    storedAt: tokenStore[id]?.storedAt || null,
  }));
}

// ===== Gerador de estado OAuth (anti-CSRF) =====
function generateState() {
  return crypto.randomBytes(32).toString('hex');
}

// ===== Rotas Express =====
export function mountOAuthRoutes(app) {
  const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;

  // GET /api/oauth/:platform/login — Redireciona para OAuth da plataforma
  app.get('/api/oauth/:platform/login', (req, res) => {
    const platform = req.params.platform;
    const cfg = OAUTH_CONFIG[platform];

    if (!cfg) return res.status(404).json({ error: 'Plataforma não suportada' });

    // Telegram usa bot token diretamente, sem OAuth2 flow
    if (platform === 'telegram') {
      const url = `https://t.me/${cfg.botUsername}?start=auth_${generateState()}`;
      return res.redirect(url);
    }

    if (!cfg.clientId) {
      return res.status(400).json({
        error: `Client ID não configurado para ${platform}`,
        setup: `Defina a variável de ambiente ${platform.toUpperCase()}_CLIENT_ID`,
      });
    }

    const state = generateState();
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      redirect_uri: `${baseUrl}/api/oauth/${platform}/callback`,
      response_type: 'code',
      scope: cfg.scopes.join(' '),
      state,
    });

    res.redirect(`${cfg.authUrl}?${params}`);
  });

  // GET /api/oauth/:platform/callback — Recebe o código e troca por token
  app.get('/api/oauth/:platform/callback', async (req, res) => {
    const platform = req.params.platform;
    const cfg = OAUTH_CONFIG[platform];
    const { code, state, error } = req.query;

    if (error) return res.status(400).json({ error: `Erro na autorização: ${error}` });
    if (!code) return res.status(400).json({ error: 'Código de autorização não recebido' });

    if (platform === 'telegram') {
      storeTokens(platform, { type: 'bot_token', token: cfg.clientId });
      return res.json({ status: 'connected', platform, message: 'Telegram conectado via bot token' });
    }

    if (!cfg.clientId || !cfg.clientSecret) {
      return res.status(400).json({ error: `Credenciais OAuth não configuradas para ${platform}` });
    }

    try {
      const params = new URLSearchParams({
        client_id: cfg.clientId,
        client_secret: cfg.clientSecret,
        code,
        redirect_uri: `${baseUrl}/api/oauth/${platform}/callback`,
        grant_type: 'authorization_code',
      });

      const tokenRes = await fetch(cfg.tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params,
      });

      if (!tokenRes.ok) {
        const errText = await tokenRes.text();
        throw new Error(`Token exchange failed: ${errText}`);
      }

      const tokens = await tokenRes.json();
      storeTokens(platform, tokens);

      res.json({
        status: 'connected',
        platform,
        expiresIn: tokens.expires_in,
        message: `${platform} conectado com sucesso!`,
      });
    } catch (err) {
      res.status(500).json({ error: `Falha na autenticação: ${err.message}` });
    }
  });

  // GET /api/oauth/status — Status de todas as conexões
  app.get('/api/oauth/status', (req, res) => {
    res.json({ connections: getAllConnections() });
  });

  // POST /api/oauth/:platform/disconnect — Desconectar
  app.post('/api/oauth/:platform/disconnect', (req, res) => {
    const platform = req.params.platform;
    delete tokenStore[platform];
    res.json({ status: 'disconnected', platform });
  });

  // GET /api/oauth/config — Configurações disponíveis
  app.get('/api/oauth/config', (req, res) => {
    res.json({
      platforms: Object.entries(OAUTH_CONFIG).map(([id, cfg]) => ({
        id,
        authUrl: cfg.authUrl,
        scopes: cfg.scopes,
        configured: !!(cfg.clientId || cfg.botUsername),
        callbackUrl: `${baseUrl}/api/oauth/${id}/callback`,
      }))
    });
  });
}
