import Ayrshare from "social-media-api";
import { query } from "./db.js";

export async function processScheduledPosts() {
  console.log("🤖 [Agente Athena] Iniciando varredura real para disparo de postagens...");

  try {
    const result = await query(`
      SELECT p.*, i.access_token AS user_api_key
      FROM user_posts p
      JOIN user_integrations i ON p.user_id = i.user_id AND p.platform = i.platform
      WHERE p.status = 'scheduled' AND p.scheduled_at <= NOW()
      LIMIT 5
    `);

    for (const post of result.rows) {
      console.log(`🚀 [Agente Athena] Processando Post ID ${post.id} → ${post.platform.toUpperCase()}`);

      try {
        const az = new Ayrshare(post.user_api_key || process.env.AYRSHARE_API_KEY);
        const postData = { post: post.content, platforms: [post.platform] };

        if (post.media_url) {
          postData.mediaUrls = [post.media_url];
        }
        if (post.platform === "instagram") {
          postData.instagramOptions = {};
          if (post.media_type === "reels") postData.instagramOptions.reel = true;
          else if (post.media_type === "stories") postData.instagramOptions.story = true;
        }

        const apiResponse = await az.post(postData);

        if (apiResponse && (apiResponse.status === "success" || apiResponse.id)) {
          await query(
            "UPDATE user_posts SET status = 'published', published_at = NOW(), error_message = NULL WHERE id = $1",
            [post.id]
          );
          console.log(`✅ [Agente Athena] Post ${post.id} publicado! Ref: ${apiResponse.id}`);
        } else {
          throw new Error(apiResponse.message || "Erro desconhecido da API");
        }
      } catch (apiError) {
        await query(
          "UPDATE user_posts SET status = 'failed', error_message = $1 WHERE id = $2",
          [apiError.message, post.id]
        );
        console.error(`❌ [Agente Athena] Falha no Post ${post.id}:`, apiError.message);
      }
    }
  } catch (err) {
    if (err.message?.includes("does not exist") || err.message?.includes("not available")) {
      console.log("ℹ️  [Agente Athena] Tabelas ainda não criadas — aguardando setup.");
    } else {
      console.error("❌ [Agente Athena] Erro no loop:", err.message);
    }
  }
}
