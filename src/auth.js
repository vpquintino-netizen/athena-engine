import jwt from "jsonwebtoken";
import { findUserByEmail } from "./db.js";

const JWT_SECRET = process.env.JWT_SECRET || "athena-ia-jwt-secret-2024";
const JWT_EXPIRES_IN = "7d";

const MASTER_EMAILS = ["vpquintino@gmail.com", "armarinhodajack@gmail.com"];
const MASTER_CREDENTIALS = {
  "vpquintino@gmail.com": { password: "@Blt18023", id: "00000000-0000-0000-0000-000000000000" },
  "armarinhodajack@gmail.com": { password: "@126373@", id: "00000000-0000-0000-0000-000000000001" },
};

export function isMasterEmail(email) {
  return MASTER_EMAILS.includes(email.toLowerCase().trim());
}

export function getMasterCred(email) {
  return MASTER_CREDENTIALS[email.toLowerCase().trim()];
}

export function generateToken(user) {
  const payload = {
    sub: user.id,
    email: user.email.toLowerCase().trim(),
    role: user.tipo_usuario || "cliente",
    plan: user.plano_status || "ativo",
  };
  return jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
}

export function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Token de acesso obrigatório" });
  }

  const token = header.split(" ")[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      role: decoded.role,
      plan: decoded.plan,
    };
    next();
  } catch (err) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expirado — faça login novamente" });
    }
    return res.status(401).json({ error: "Token inválido" });
  }
}

export function requireActivePlan(req, res, next) {
  const isMaster = isMasterEmail(req.user.email);
  if (isMaster) {
    return next();
  }

  if (req.user.plan !== "ativo") {
    return res.status(402).json({
      error: "Plano inativo",
      message: "Seu plano está inativo. Efetue o pagamento de R$ 350 para reativar.",
      redirect: "/index.html",
    });
  }

  next();
}

export function requireMaster(req, res, next) {
  if (!isMasterEmail(req.user.email)) {
    return res.status(403).json({ error: "Acesso restrito a administradores" });
  }
  next();
}
