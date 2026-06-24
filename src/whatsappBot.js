import { Client, LocalAuth } from "whatsapp-web.js";
import qrcode from "qrcode-terminal";
import { query } from "./db.js";

let botStatus = "Desconectado. Aguardando QR Code.";
let customResponseCache = "";

export function initWhatsAppBot() {
  console.log("🤖 [WhatsApp Bot] Inicializando motor de escuta gratuito...");

  const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: { args: ["--no-sandbox", "--disable-setuid-sandbox"] },
  });

  client.on("qr", (qr) => {
    botStatus = "Aguardando leitura de QR Code no painel";
    console.log("👇 ESCANEIE O QR CODE ABAIXO PARA CONECTAR:");
    qrcode.generate(qr, { small: true });
  });

  client.on("ready", () => {
    botStatus = "Conectado e Operando online!";
    console.log("🚀 [WhatsApp Bot] Chatbot Athena IA ativo.");
  });

  client.on("message", async (msg) => {
    if (msg.from.includes("@g.us")) return;
    const reply = customResponseCache || "Olá! Sou o assistente virtual da Athena IA. Como posso ajudar?";
    await msg.reply(reply);
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
    console.log("[WhatsApp] Contexto do bot atualizado.");
  } catch (err) {
    console.log("[WhatsApp] Cache atualizado (banco indisponível):", err.message);
  }
}
