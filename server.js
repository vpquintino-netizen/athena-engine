import "dotenv/config";
import express from "express";
import cors from "cors";
import { MercadoPagoConfig, Preference } from "mercadopago";

const app = express();
const PORT = process.env.PORT || 3000;

const accessToken = process.env.MERCADO_PAGO_TOKEN || process.env.MP_ACCESS_TOKEN;
const client = new MercadoPagoConfig({ accessToken });

app.use(cors());
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

app.use(express.static("public"));

app.post("/create-preference", async (req, res) => {
  try {
    const { title, quantity, unit_price, email } = req.body;

    const baseUrl = process.env.BASE_URL || `${req.protocol}://${req.hostname}:${PORT}`;

    const preference = new Preference(client);

    const result = await preference.create({
      body: {
        items: [
          {
            title: title || "Plano Athena IA Pro",
            quantity: Number(quantity) || 1,
            unit_price: Number(unit_price) || 29.9,
            currency_id: "BRL",
          },
        ],
        payer: { email: email || "" },
        back_urls: {
          success: `${baseUrl}/dashboard.html`,
          failure: `${baseUrl}/index.html`,
          pending: `${baseUrl}/index.html`,
        },
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
      const response = await fetch(
        `https://api.mercadopago.com/v1/payments/${paymentId}`,
        { headers: { Authorization: `Bearer ${accessToken}` } }
      );
      const payment = await response.json();
      console.log("Pagamento recebido:", payment.id, "- Status:", payment.status);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("Erro no webhook:", err);
    res.sendStatus(200);
  }
});

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`Athena IA rodando em http://localhost:${PORT}`));
