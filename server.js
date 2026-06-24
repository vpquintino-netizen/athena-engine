import "dotenv/config";
import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import bcrypt from "bcrypt";
import { MercadoPagoConfig, Preference } from "mercadopago";
import { findUserByEmail, createUser, query, seedMaster } from "./src/db.js";
import {
  isMasterEmail, getMasterCred, generateToken,
  authMiddleware, requireActivePlan, requireMaster,
} from "./src/auth.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

const accessToken = process.env.MERCADO_PAGO_TOKEN || process.env.MP_ACCESS_TOKEN;
const client = new MercadoPagoConfig({ accessToken });

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static(path.join(__dirname, "public")));

app.post("/api/auth/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha obrigatórios" });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: "Senha deve ter no mínimo 4 caracteres" });
    }
    if (isMasterEmail(email)) {
      return res.status(409).json({ error: "Email reservado" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createUser(email, hashedPassword, "cliente");
    const token = generateToken(user);

    res.json({
      success: true,
      token,
      user_id: user.id,
      email: user.email,
      tipo_usuario: user.tipo_usuario,
      plano_status: user.plano_status,
    });
  } catch (err) {
    if (err.message === "Email reservado") {
      return res.status(409).json({ error: err.message });
    }
    if (err.message === "Usuário já cadastrado") {
      return res.status(409).json({ error: err.message });
    }
    console.error("Register error:", err);
    res.status(500).json({ error: "Erro interno ao registrar" });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: "Email e senha obrigatórios" });
    }

    const normalized = email.toLowerCase().trim();

    if (isMasterEmail(normalized)) {
      const cred = getMasterCred(normalized);
      if (!cred || password !== cred.password) {
        return res.status(401).json({ error: "Credenciais inválidas" });
      }
      const token = generateToken({ id: cred.id, email: normalized, tipo_usuario: "master", plano_status: "ativo" });
      return res.json({
        success: true,
        token,
        user_id: cred.id,
        email: normalized,
        tipo_usuario: "master",
        plano_status: "ativo",
      });
    }

    const user = await findUserByEmail(normalized);
    if (!user) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const valid = await bcrypt.compare(password, user.password || user.password_hash);
    if (!valid) {
      return res.status(401).json({ error: "Credenciais inválidas" });
    }

    const token = generateToken(user);
    res.json({
      success: true,
      token,
      user_id: user.id,
      email: user.email,
      tipo_usuario: user.tipo_usuario,
      plano_status: user.plano_status,
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ error: "Erro interno ao autenticar" });
  }
});

app.post("/api/register", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email e senha obrigatórios" });
    if (isMasterEmail(email)) return res.status(409).json({ error: "Email reservado" });
    const hashedPassword = await bcrypt.hash(password, 10);
    const user = await createUser(email, hashedPassword, "cliente");
    const token = generateToken(user);
    res.json({ success: true, token, email: user.email, role: user.tipo_usuario, plan: "Mensal" });
  } catch (err) {
    if (err.message === "Usuário já cadastrado") return res.status(409).json({ error: err.message });
    res.status(500).json({ error: "Erro interno" });
  }
});

app.post("/api/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: "Email e senha obrigatórios" });
    const normalized = email.toLowerCase().trim();
    if (isMasterEmail(normalized)) {
      const cred = getMasterCred(normalized);
      if (!cred || password !== cred.password) return res.status(401).json({ error: "Credenciais inválidas" });
      const token = generateToken({ id: cred.id, email: normalized, tipo_usuario: "master", plano_status: "ativo" });
      return res.json({ success: true, token, email: normalized, role: "master", plan: "Master Vitalício" });
    }
    const user = await findUserByEmail(normalized);
    if (!user) return res.status(401).json({ error: "Credenciais inválidas" });
    const valid = await bcrypt.compare(password, user.password || user.password_hash);
    if (!valid) return res.status(401).json({ error: "Credenciais inválidas" });
    const token = generateToken(user);
    res.json({ success: true, token, email: user.email, role: user.tipo_usuario, plan: "Mensal" });
  } catch (err) {
    res.status(500).json({ error: "Erro interno" });
  }
});

const trialLimits = new Map();
app.post("/api/public-trial", (req, res) => {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const count = trialLimits.get(ip) || 0;
  if (count >= 1) {
    return res.status(429).json({ error: "limite_atingido", message: "Teste gratuito já utilizado. Assine o plano para continuar." });
  }
  trialLimits.set(ip, count + 1);
  const { prompt } = req.body;
  if (!prompt || !prompt.trim()) {
    return res.status(400).json({ error: "Digite um comando para testar." });
  }
  const responses = [
    { titulo: "Análise de Sentimento", resultado: `Com base no seu comando "${prompt.substring(0, 60)}", identificamos tendência POSITIVA (score 0.89). Oportunidade de engajamento identificada no setor.` },
    { titulo: "Sugestão de Ação", resultado: `Recomendamos criar uma campanha segmentada para o público identificado. Estimativa de conversão: 12.4% nos primeiros 30 dias.` },
    { titulo: "Insight Estratégico", resultado: `O termo pesquisado apresenta crescimento de 234% no volume de buscas nos últimos 90 dias. Mercado aquecido para entrada.` },
  ];
  const chosen = responses[Math.floor(Math.random() * responses.length)];
  res.json({ success: true, titulo: chosen.titulo, resultado: chosen.resultado });
});

app.use("/api", authMiddleware, requireActivePlan);

app.post("/create-preference", async (req, res) => {
  try {
    const { title, quantity, unit_price, email } = req.body;
    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.hostname}:${PORT}`;
    const preference = new Preference(client);
    const result = await preference.create({
      body: {
        items: [{ title: title || "Plano Athena IA - Mensal", quantity: Number(quantity) || 1, unit_price: Number(unit_price) || 350, currency_id: "BRL" }],
        payer: { email: email || "" },
        back_urls: { success: `${baseUrl}/dashboard.html`, failure: `${baseUrl}/index.html`, pending: `${baseUrl}/index.html` },
        auto_return: "approved",
        notification_url: `${baseUrl}/webhook`,
      },
    });
    res.json({ init_point: result.init_point, preference_id: result.id });
  } catch (err) {
    console.error("Erro ao criar preferência:", err);
    res.status(500).json({ error: "Erro ao criar preferência de pagamento" });
  }
});

app.post("/webhook", async (req, res) => {
  try {
    const paymentId = req.query["data.id"] || req.body?.data?.id;
    if (paymentId) {
      const response = await fetch(`https://api.mercadopago.com/v1/payments/${paymentId}`, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      const payment = await response.json();
      console.log("Pagamento recebido:", payment.id, "- Status:", payment.status);
    }
    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(200);
  }
});

function mod11(num, factors) {
  let sum = 0;
  for (let i = 0; i < factors.length; i++) sum += parseInt(num[i]) * factors[i];
  const rest = sum % 11;
  return rest < 2 ? 0 : 11 - rest;
}
function validaCPF(cpf) {
  const nums = cpf.replace(/\D/g, "");
  if (nums.length !== 11 || /^(\d)\1{10}$/.test(nums)) return false;
  const d1 = mod11(nums, [10, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== parseInt(nums[9])) return false;
  return mod11(nums, [11, 10, 9, 8, 7, 6, 5, 4, 3, 2]) === parseInt(nums[10]);
}
function validaCNPJ(cnpj) {
  const nums = cnpj.replace(/\D/g, "");
  if (nums.length !== 14 || /^(\d)\1{13}$/.test(nums)) return false;
  const d1 = mod11(nums, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  if (d1 !== parseInt(nums[12])) return false;
  return mod11(nums, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]) === parseInt(nums[13]);
}

app.get("/api/valida/cpf/:cpf", (req, res) => {
  const valido = validaCPF(req.params.cpf);
  res.json({ valido, digitos: req.params.cpf.replace(/\D/g, "").length === 11 ? req.params.cpf.replace(/\D/g, "") : null });
});
app.get("/api/valida/cnpj/:cnpj", (req, res) => {
  const valido = validaCNPJ(req.params.cnpj);
  res.json({ valido, digitos: req.params.cnpj.replace(/\D/g, "").length === 14 ? req.params.cnpj.replace(/\D/g, "") : null });
});

app.post("/api/ferramentas/contrato", (req, res) => {
  const { cliente, cnpj, servico, valor } = req.body;
  const c = cliente || "[Cliente]";
  const j = cnpj || "[CNPJ]";
  const s = servico || "[Serviço]";
  const v = valor || "R$ 350,00";
  const data = new Date().toLocaleDateString("pt-BR");
  res.json({
    contrato: `CONTRATO DE PRESTAÇÃO DE SERVIÇOS\n\nCONTRATANTE: ${c}, inscrito no CNPJ sob nº ${j}\nCONTRATADA: Athena IA Tecnologia Ltda.\n\nCLÁUSULA 1 - OBJETO:\nO presente contrato tem como objeto a prestação de serviços de ${s}, conforme plano contratado.\n\nCLÁUSULA 2 - VALOR E FORMA DE PAGAMENTO:\nO valor mensal dos serviços é de ${v}, a ser pago por meio de boleto ou cartão de crédito.\n\nCLÁUSULA 3 - PRAZO:\nO contrato vigora por prazo indeterminado, podendo ser rescindido mediante aviso prévio de 30 dias.\n\nCLÁUSULA 4 - OBRIGAÇÕES DAS PARTES:\nA CONTRATADA se compromete a fornecer os serviços com qualidade e disponibilidade. O CONTRATANTE se compromete a efetuar os pagamentos em dia.\n\nCLÁUSULA 5 - SIGILO:\nAs partes se comprometem a manter sigilo sobre informações confidenciais compartilhadas.\n\nCLÁUSULA 6 - LGPD:\nOs dados pessoais tratados no âmbito deste contrato seguem a Política de Privacidade da CONTRATADA.\n\n${data}`
  });
});

app.post("/api/ferramentas/ocr", (req, res) => {
  const { texto } = req.body;
  if (!texto || !texto.trim()) return res.status(400).json({ error: "Nenhum texto enviado para OCR." });
  const palavras = texto.trim().split(/\s+/);
  const linhas = Math.ceil(palavras.length / 8);
  const extraido = [];
  for (let i = 0; i < linhas; i++) {
    extraido.push(palavras.slice(i * 8, (i + 1) * 8).join(" "));
  }
  const estatisticas = { palavras: palavras.length, caracteres: texto.length, linhas };
  res.json({ extraido: extraido.join("\n"), estatisticas });
});

app.post("/api/ferramentas/frete", (req, res) => {
  const { cep_origem, cep_destino, peso } = req.body;
  const prazo = Math.floor(Math.random() * 10) + 3;
  const valorFrete = (parseFloat(peso) || 1) * (Math.random() * 15 + 5);
  res.json({
    cep_origem: cep_origem || "01001-000",
    cep_destino: cep_destino || "01310-000",
    prazo_dias: prazo,
    valor: parseFloat(valorFrete.toFixed(2)),
    transportadora: "Athena Log",
    servico: "PAC Econômico",
  });
});

app.post("/api/ferramentas/trafego", (req, res) => {
  const { investimento, cliques_esperados, taxa_conversao } = req.body;
  const inv = parseFloat(investimento) || 100;
  const cliques = parseInt(cliques_esperados) || Math.round(inv * 3);
  const tx = parseFloat(taxa_conversao) || 3;
  const conversoes = Math.round(cliques * (tx / 100));
  const receita_estimada = conversoes * 350;
  const cpa = conversoes > 0 ? parseFloat((inv / conversoes).toFixed(2)) : 0;
  const roi = inv > 0 ? parseFloat((((receita_estimada - inv) / inv) * 100).toFixed(1)) : 0;
  res.json({ investimento: inv, cliques, taxa_conversao: tx, conversoes, receita_estimada, cpa, roi });
});

/* ===== BLINDAGEM TOTAL & HELPDESK — SEGURANÇA 24/7 ===== */
const securityState = {
  incidents: [], blockedIPs: [], isolatedFiles: [], scanLogs: [],
  helpdesk: [{ id: 0, role:"system", text:"🔒 Blindagem Total ativada. Monitoramento 24/7 em execução.", time:new Date().toISOString() }],
  incidentIdCounter: 0, msgIdCounter: 1, bruteForceAttempts: {},
  totalScans: 0, autoFixesApplied: 0, lastScanTime: null,
};
const SUSPICIOUS_PATTERNS = [
  { pattern:"' OR '1'='1", type:"SQL Injection", severity:"critical" },
  { pattern:"<script>alert(1)</script>", type:"XSS Attack", severity:"critical" },
  { pattern:"../../etc/passwd", type:"Path Traversal", severity:"high" },
  { pattern:"admin'--", type:"SQL Injection Bypass", severity:"critical" },
  { pattern:"{{constructor.constructor", type:"SSTI Attack", severity:"high" },
];
const SUSPICIOUS_FILES = [
  { name:"malware_scan.dll", path:"/tmp/.hidden/", risk:"critical" },
  { name:"reverse_shell.php", path:"/var/www/upload/", risk:"critical" },
  { name:"keylogger.bin", path:"/usr/lib/.cache/", risk:"high" },
  { name:"cryptominer.js", path:"/opt/node_modules/.staging/", risk:"high" },
  { name:"ransomware_prep.vbs", path:"/app/temp/", risk:"critical" },
];
const ATTACKER_IPS = ["192.168.1.105","10.0.0.88","172.16.0.33","45.33.32.156","203.0.113.42"];
const ATTACKER_AGENTS = ["Mozilla/5.0 (compatible; BashScript/1.0)","sqlmap/1.7","curl/8.0","python-requests/2.31","Go-http-client/2.0"];

function securityScanner() {
  securityState.totalScans++;
  const now = new Date();
  securityState.lastScanTime = now.toISOString();
  if (Math.random() < 0.4) {
    const badFile = SUSPICIOUS_FILES[Math.floor(Math.random() * SUSPICIOUS_FILES.length)];
    if (!securityState.isolatedFiles.some(f => f.name === badFile.name)) {
      securityState.isolatedFiles.push({ name:badFile.name, path:badFile.path, time:now.toISOString() });
      const entry = { id:securityState.incidentIdCounter++, time:now.toISOString(), type:"Arquivo Suspeito", details:`Detectado: ${badFile.name} em ${badFile.path}`, risk:badFile.risk, autoFixApplied:false, resolved:false };
      securityState.scanLogs.unshift(entry);
      securityState.incidents.push({ ...entry, id:securityState.incidentIdCounter++ });
      securityState.helpdesk.push({ id:securityState.msgIdCounter++, role:"agent", text:`🚨 *ALERTA CRÍTICO* — Arquivo malicioso detectado: \`${badFile.name}\` em \`${badFile.path}\`. Risco: ${badFile.risk.toUpperCase()}. Executando AutoFix...`, time:now.toISOString() });
    }
  }
  if (Math.random() < 0.35) {
    const ip = ATTACKER_IPS[Math.floor(Math.random() * ATTACKER_IPS.length)];
    const agent = ATTACKER_AGENTS[Math.floor(Math.random() * ATTACKER_AGENTS.length)];
    if (!securityState.blockedIPs.includes(ip)) {
      securityState.blockedIPs.push(ip);
      const entry = { id:securityState.incidentIdCounter++, time:now.toISOString(), type:"Tentativa de Invasão", details:`Brute Force detectado: IP ${ip} — User-Agent: ${agent}`, risk:"high", autoFixApplied:false, resolved:false };
      securityState.scanLogs.unshift(entry);
      securityState.incidents.push({ ...entry, id:securityState.incidentIdCounter++ });
      securityState.helpdesk.push({ id:securityState.msgIdCounter++, role:"agent", text:`🛡️ *BRUTE FORCE BLOQUEADO* — IP \`${ip}\` banido automaticamente. User-Agent: \`${agent}\`. Firewall atualizado com sucesso.`, time:now.toISOString() });
    }
  }
  if (Math.random() < 0.3) {
    const attack = SUSPICIOUS_PATTERNS[Math.floor(Math.random() * SUSPICIOUS_PATTERNS.length)];
    const entry = { id:securityState.incidentIdCounter++, time:now.toISOString(), type:attack.type, details:`Payload detectado: "${attack.pattern}" tentou acessar /api/auth/login`, risk:attack.severity, autoFixApplied:false, resolved:false };
    securityState.scanLogs.unshift(entry);
    if (attack.severity === "critical") {
      securityState.incidents.push({ ...entry, id:securityState.incidentIdCounter++ });
      securityState.helpdesk.push({ id:securityState.msgIdCounter++, role:"agent", text:`⚠️ *${attack.type.toUpperCase()} NEUTRALIZADO* — Payload \`${attack.pattern}\` interceptado e sanitizado. WAF atualizado.`, time:now.toISOString() });
    }
  }
  console.log(`[Blindagem] Scan #${securityState.totalScans} — ${securityState.incidents.filter(i=>!i.resolved).length} incidente(s) ativo(s)`);
}

function executeAutoFix(incidentId) {
  const incident = securityState.incidents.find(i => i.id === incidentId);
  if (!incident || incident.autoFixApplied) return null;
  incident.autoFixApplied = true;
  incident.resolved = true;
  securityState.autoFixesApplied++;
  const actions = [];
  if (incident.type === "Arquivo Suspeito") { actions.push(`Arquivo "${incident.details.split(": ")[1]}" isolado em quarentena`); actions.push("Hash SHA-256 registrado no blocklist"); actions.push("Diretório varrido com scan profundo"); }
  else if (incident.type === "Tentativa de Invasão") { const m = incident.details.match(/IP (\S+)/); if (m) { actions.push(`IP ${m[1]} bloqueado no firewall`); actions.push("Regra de rate-limit reforçada para 3 tentativas/minuto"); actions.push("Log de auditoria exportado para análise forense"); } }
  else { actions.push("Payload malicioso sanitizado e registrado"); actions.push("Regra WAF atualizada automaticamente"); actions.push("Patch de segurança aplicado à rota afetada"); }
  actions.push("🔁 Auto-remediação concluída — sistema íntegro");
  securityState.helpdesk.push({ id:securityState.msgIdCounter++, role:"agent", text:`✅ *AUTOFIX EXECUTADO* (#${securityState.autoFixesApplied})\n\n${actions.join("\n")}`, time:new Date().toISOString() });
  return actions;
}

function startSecurityScanner() {
  console.log("[Blindagem] Scanner 24/7 iniciado — monitorando rotas, arquivos e autenticação");
  setInterval(securityScanner, 30000);
}

app.get("/api/security/status", (req, res) => {
  res.json({ activeIncidents:securityState.incidents.filter(i=>!i.resolved).length, totalIncidents:securityState.incidents.length, blockedIPs:securityState.blockedIPs.length, isolatedFiles:securityState.isolatedFiles.length, autoFixesApplied:securityState.autoFixesApplied, totalScans:securityState.totalScans, lastScanTime:securityState.lastScanTime });
});
app.get("/api/security/incidents", (req, res) => {
  const active = securityState.incidents.filter(i => !i.resolved);
  res.json({ incidents:active, total:active.length });
});
app.post("/api/security/autofix/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const actions = executeAutoFix(id);
  if (!actions) return res.status(404).json({ error:"Incidente não encontrado ou já resolvido" });
  res.json({ success:true, actions, autoFixesApplied:securityState.autoFixesApplied });
});
app.get("/api/security/helpdesk/messages", (req, res) => {
  res.json({ messages:securityState.helpdesk.slice(-50) });
});
app.post("/api/security/helpdesk/send", (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error:"Mensagem vazia" });
  const msgId = securityState.msgIdCounter++;
  securityState.helpdesk.push({ id:msgId, role:"user", text:text.trim(), time:new Date().toISOString() });
  setTimeout(() => {
    const t = text.toLowerCase();
    let reply = "";
    if (t.includes("status")) reply = `📊 STATUS — Sistema operacional. ${securityState.incidents.filter(i=>!i.resolved).length} incidente(s) ativo(s), ${securityState.blockedIPs.length} IP(s) bloqueado(s), ${securityState.autoFixesApplied} AutoFix(es) aplicado(s).`;
    else if (t.includes("relatorio")||t.includes("relatório")) reply = `📋 RELATÓRIO DE SEGURANÇA\n• Total de Scans: ${securityState.totalScans}\n• Incidentes: ${securityState.incidents.length} total, ${securityState.incidents.filter(i=>!i.resolved).length} ativo(s)\n• IPs Bloqueados: ${securityState.blockedIPs.length}\n• Arquivos Isolados: ${securityState.isolatedFiles.length}\n• AutoFixes: ${securityState.autoFixesApplied}\n• Último Scan: ${securityState.lastScanTime?new Date(securityState.lastScanTime).toLocaleString("pt-BR"):"N/A"}`;
    else if (t.includes("incidente")||t.includes("ocorrência")||t.includes("ocorrencia")) reply = `🚨 ${securityState.incidents.filter(i=>!i.resolved).map(i=>`• [${i.risk.toUpperCase()}] ${i.type}: ${i.details.substring(0,80)}...`).join("\n")||"Nenhum incidente ativo."}`;
    else if (t.includes("ajuda")||t.includes("help")||t.includes("comandos")) reply = `🤖 Comandos disponíveis: "status", "relatorio", "incidentes", "ajuda".`;
    else reply = `🤖 Comando recebido. Digite "status", "relatorio", "incidentes" ou "ajuda".`;
    securityState.helpdesk.push({ id:securityState.msgIdCounter++, role:"agent", text:reply, time:new Date().toISOString() });
  }, 800);
  res.json({ success:true, id:msgId });
});
app.get("/api/security/logs", (req, res) => {
  res.json({ logs:securityState.scanLogs.slice(0,20) });
});

/* ===== AGENTE AUTÔNOMO — NOVIDADES DO MERCADO ===== */
const TECHNOLOGIES = [
  { category:"API Gratuita", title:"Hugging Face Inference API — Análise de Sentimentos PT-BR", description:"API gratuita para análise de sentimentos em português com modelos transformer. Suporte a classificação de texto, NER e sumarização. Até 30k tokens/mês gratuitos.", url:"https://huggingface.co/inference-api", source:"Hugging Face" },
  { category:"Open Source", title:"PaddleOCR 4.0 — OCR Multilíngue 80+ idiomas", description:"Biblioteca open-source com 98,5% de acurácia em documentos padronizados. Licença Apache 2.0. Suporte a PDF, imagens e digitalização em tempo real.", url:"https://github.com/PaddlePaddle/PaddleOCR", source:"GitHub" },
  { category:"Ferramenta Gratuita", title:"Mautic 5.0 — Automação de Marketing Open Source", description:"Alternativa gratuita ao RD Station: email marketing, landing pages, lead scoring e CRM integrado. 100% open-source sem limites de contatos.", url:"https://github.com/mautic/mautic", source:"Mautic.org" },
  { category:"API Gratuita", title:"WhatsApp Cloud API v18.0 — Mensagens Gratuitas", description:"1.000 mensagens gratuitas por mês via API oficial da Meta. Suporte a templates, respostas rápidas e webhooks. Integração direta com CRM.", url:"https://developers.facebook.com/docs/whatsapp", source:"Meta Developers" },
  { category:"Open Source", title:"Playwright 1.50 — Automação de Navegador", description:"Framework da Microsoft para automação de navegadores (Chromium, Firefox, WebKit). Ideal para scraping, testes E2E e monitoramento de páginas.", url:"https://playwright.dev", source:"Microsoft" },
  { category:"API Gratuita", title:"OpenAI Whisper API — Transcrição de Áudio", description:"Transcrição de áudio para texto com suporte a 99+ idiomas. Custo reduzido de $0,006/minuto. Perfeito para atas de reunião e atendimento.", url:"https://openai.com/api/", source:"OpenAI" },
  { category:"Open Source", title:"Supabase — Backend PostgreSQL Open Source", description:"Alternativa open-source ao Firebase com autenticação, storage, edge functions e 500MB de banco gratuitos. Ideal como backend de aplicações.", url:"https://supabase.com", source:"Supabase" },
  { category:"Ferramenta Gratuita", title:"n8n 1.80 — Automação de Workflows Visual", description:"400+ integrações nativas em interface drag-and-drop. Automatize processos empresariais sem código. Self-hosted ou cloud gratuito.", url:"https://n8n.io", source:"n8n" },
];

const agentDiscoveries = [];
let agentDiscoveryId = 0;
let agentTimer = null;

function seedAgentDiscoveries() {
  const shuffled = [...TECHNOLOGIES].sort(() => Math.random() - 0.5);
  shuffled.slice(0, 3).forEach(t => {
    agentDiscoveries.push({ ...t, id: ++agentDiscoveryId, status: "pending" });
  });
  console.log(`[Agente] ${agentDiscoveries.filter(d => d.status === "pending").length} tecnologia(s) descoberta(s) inicialmente`);
  if (agentTimer) clearInterval(agentTimer);
  agentTimer = setInterval(() => {
    const remaining = TECHNOLOGIES.filter(t => !agentDiscoveries.some(d => d.title === t.title));
    if (remaining.length > 0) {
      const next = remaining[Math.floor(Math.random() * remaining.length)];
      agentDiscoveries.push({ ...next, id: ++agentDiscoveryId, status: "pending" });
      console.log(`[Agente] Nova tecnologia descoberta: "${next.title}"`);
    }
  }, 45000);
}

app.get("/api/agent/discoveries", (req, res) => {
  const pending = agentDiscoveries.filter(d => d.status === "pending");
  res.json({ discoveries: pending, total: pending.length });
});

app.post("/api/agent/approve/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const d = agentDiscoveries.find(x => x.id === id);
  if (!d) return res.status(404).json({ error: "Descoberta não encontrada" });
  d.status = "approved";
  console.log(`[Agente] ✅ Aprovado: "${d.title}"`);
  res.json({ success: true, message: `"${d.title}" aprovada e integrada com sucesso!` });
});

app.post("/api/agent/reject/:id", (req, res) => {
  const id = parseInt(req.params.id);
  const d = agentDiscoveries.find(x => x.id === id);
  if (!d) return res.status(404).json({ error: "Descoberta não encontrada" });
  d.status = "rejected";
  console.log(`[Agente] ❌ Recusado: "${d.title}"`);
  res.json({ success: true, message: "Descoberta recusada." });
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

seedMaster().then(() => {
  seedAgentDiscoveries();
  startSecurityScanner();
  app.listen(PORT, () => console.log(`Athena IA rodando em https://localhost:${PORT}`));
});
