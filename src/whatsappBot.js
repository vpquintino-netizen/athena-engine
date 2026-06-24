import wweb from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { query } from "./db.js";

const { Client, LocalAuth } = wweb;

let botStatus = "Desconectado. Aguardando QR Code.";
let customResponseCache = "";

export function initWhatsAppBot() {
  console.log("🤖 [WhatsApp Bot] Inicializando motor otimizado para produção...");

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", (qr) => {
    botStatus = "Aguardando leitura de QR Code no painel";
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    botStatus = "Conectado e Operando online!";
    console.log("🚀 [WhatsApp Bot] Automação ativada.");
  });

  client.on("message", async (msg) => {
    if (msg.from.includes("@g.us")) return;

    const reply =
      customResponseCache ||
      "Olá! Sou o assistente virtual da Athena IA. Como posso ajudar?";
    try {
      await msg.reply(reply);
      await query(
        `INSERT INTO user_leads (user_id, lead_phone, status, estimated_value)
         VALUES ($1, $2, 'atendido', 99.70) ON CONFLICT DO NOTHING`,
        [1, msg.from]
      );
    } catch (e) {
      if (!e.message?.includes("not available")) {
        console.error("⚠️ [WhatsApp] Erro no disparo:", e.message);
      }
    }
  });

  client.initialize().catch((err) => console.error("Erro WhatsApp:", err.message));
}

export function getWhatsAppStatus() {
  return botStatus;
}

export async function updateBotContext(contextPrompt) {
  customResponseCache = contextPrompt;
  try {
    await query(
      `INSERT INTO chatbot_configs (user_id, bot_status, context_prompt)
       VALUES ($1, 'active', $2)
       ON CONFLICT (user_id) DO UPDATE SET context_prompt = $2`,
      [1, contextPrompt]
    );
  } catch (err) {
    if (!err.message?.includes("not available")) {
      console.log("[WhatsApp] Cache salvo:", err.message);
    }
  }
}
