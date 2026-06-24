import { query } from "./db.js";

const memoryCache = {};

export async function loadCompanyMemory(userId) {
  if (memoryCache[userId]) return memoryCache[userId];
  try {
    const res = await query("SELECT context_prompt FROM chatbot_configs WHERE user_id = $1", [userId]);
    if (res.rows.length > 0) {
      memoryCache[userId] = res.rows[0].context_prompt;
      return memoryCache[userId];
    }
  } catch (err) {
    if (!err.message?.includes("not available")) {
      console.error("⚠️ [Memória] Erro ao carregar contexto:", err.message);
    }
  }
  return null;
}

export function updateLiveMemory(userId, newContext) {
  memoryCache[userId] = newContext;
  console.log(`🧠 [Memória] Cache atualizado para user ${userId}`);
}

export function getLiveMemory(userId) {
  return memoryCache[userId] || null;
}
