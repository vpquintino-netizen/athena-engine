import { query, isDBReady } from './database.js';
import { authMiddleware, tenantIsolation } from './auth.js';

// ===== Dados simulados de alta fidelidade por CPF/CNPJ =====
// Simula consulta a bases públicas sem custo de API externa
const COMPANY_DB = {
  // CNPJs simulados por setor
  '11222333000181': { name: 'Tech Solutions Ltda',           primary_color: '#2563eb', secondary_color: '#7c3aed', logo: 'https://ui-avatars.com/api/?name=Tech+Solutions&background=2563eb&color=fff&size=128' },
  '22333444000192': { name: 'Comércio Digital S.A.',         primary_color: '#dc2626', secondary_color: '#f59e0b', logo: 'https://ui-avatars.com/api/?name=Comercio+Digital&background=dc2626&color=fff&size=128' },
  '33444555000103': { name: 'Agência Criativa ME',           primary_color: '#ec4899', secondary_color: '#06b6d4', logo: 'https://ui-avatars.com/api/?name=Ag+Criativa&background=ec4899&color=fff&size=128' },
  '44555666000114': { name: 'Indústria Nacional Ltda',       primary_color: '#16a34a', secondary_color: '#2563eb', logo: 'https://ui-avatars.com/api/?name=Industria+Nac&background=16a34a&color=fff&size=128' },
  '55666777000125': { name: 'Consultoria Estratégica SS',    primary_color: '#7c3aed', secondary_color: '#3b82f6', logo: 'https://ui-avatars.com/api/?name=Consult+Estrategica&background=7c3aed&color=fff&size=128' },
  '66777888000136': { name: 'Serviços Gerais Eireli',        primary_color: '#0891b2', secondary_color: '#059669', logo: 'https://ui-avatars.com/api/?name=Servicos+Gerais&background=0891b2&color=fff&size=128' },
  '77888999000147': { name: 'Alimentos Premium Ltda',        primary_color: '#ea580c', secondary_color: '#ca8a04', logo: 'https://ui-avatars.com/api/?name=Alimentos+Premium&background=ea580c&color=fff&size=128' },
  '88999000000158': { name: 'Transportadora Rápida Ltda',    primary_color: '#1d4ed8', secondary_color: '#dc2626', logo: 'https://ui-avatars.com/api/?name=Transport+Rapida&background=1d4ed8&color=fff&size=128' },
  '99000111000169': { name: 'Educação Futura S.A.',           primary_color: '#6d28d9', secondary_color: '#d97706', logo: 'https://ui-avatars.com/api/?name=Educacao+Futura&background=6d28d9&color=fff&size=128' },
  '00111222000170': { name: 'Saúde e Bem-Estar Ltda',         primary_color: '#059669', secondary_color: '#0284c7', logo: 'https://ui-avatars.com/api/?name=Saude+Bem+Estar&background=059669&color=fff&size=128' },
};

const CPF_DB = {
  '12345678909': { name: 'Ana Silva Oliveira',               primary_color: '#7c3aed', secondary_color: '#3b82f6', logo: 'https://ui-avatars.com/api/?name=Ana+Silva&background=7c3aed&color=fff&size=128' },
  '98765432100': { name: 'Carlos Eduardo Santos',            primary_color: '#2563eb', secondary_color: '#7c3aed', logo: 'https://ui-avatars.com/api/?name=Carlos+Eduardo&background=2563eb&color=fff&size=128' },
  '11122233344': { name: 'Mariana Costa Lima',               primary_color: '#ec4899', secondary_color: '#06b6d4', logo: 'https://ui-avatars.com/api/?name=Mariana+Costa&background=ec4899&color=fff&size=128' },
  '55566677788': { name: 'Pedro Henrique Alves',             primary_color: '#16a34a', secondary_color: '#2563eb', logo: 'https://ui-avatars.com/api/?name=Pedro+Henrique&background=16a34a&color=fff&size=128' },
  '99988877766': { name: 'Juliana Ferreira Martins',         primary_color: '#dc2626', secondary_color: '#f59e0b', logo: 'https://ui-avatars.com/api/?name=Juliana+Ferreira&background=dc2626&color=fff&size=128' },
};

// ===== Validador de CPF =====
function validateCPF(cpf) {
  const digits = cpf.replace(/\D/g, '');
  if (digits.length !== 11) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += parseInt(digits[i]) * (10 - i);
  let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0;
  sum = 0;
  for (let i = 0; i < 10; i++) sum += parseInt(digits[i]) * (11 - i);
  let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0;
  return d1 === parseInt(digits[9]) && d2 === parseInt(digits[10]);
}

// ===== Validador de CNPJ =====
function validateCNPJ(cnpj) {
  const digits = cnpj.replace(/\D/g, '');
  if (digits.length !== 14) return false;
  let size = 12;
  let numbers = digits.slice(0, size);
  let sum = 0;
  const weights1 = [5,4,3,2,9,8,7,6,5,4,3,2];
  for (let i = 0; i < size; i++) sum += parseInt(numbers[i]) * weights1[i];
  let d1 = 11 - (sum % 11); if (d1 >= 10) d1 = 0;
  numbers += d1; size = 13;
  sum = 0;
  const weights2 = [6,5,4,3,2,9,8,7,6,5,4,3,2];
  for (let i = 0; i < size; i++) sum += parseInt(numbers[i]) * weights2[i];
  let d2 = 11 - (sum % 11); if (d2 >= 10) d2 = 0;
  return d1 === parseInt(digits[12]) && d2 === parseInt(digits[13]);
}

// ===== Identificar tipo de documento =====
function identifyDoc(doc) {
  const cleaned = doc.replace(/\D/g, '');
  if (cleaned.length === 11) return { type: 'cpf', validated: validateCPF(cleaned), digits: cleaned };
  if (cleaned.length === 14) return { type: 'cnpj', validated: validateCNPJ(cleaned), digits: cleaned };
  return { type: 'unknown', validated: false, digits: cleaned };
}

// ===== Buscar dados da empresa (simulado) =====
function lookupCompany(docType, digits) {
  if (docType === 'cpf') {
    return CPF_DB[digits] || {
      name: `Usuário CPF ${digits.slice(0,3)}.***.***-${digits.slice(9)}`,
      primary_color: '#7c3aed',
      secondary_color: '#3b82f6',
      logo: `https://ui-avatars.com/api/?name=Usuario&background=7c3aed&color=fff&size=128`,
    };
  }
  if (docType === 'cnpj') {
    return COMPANY_DB[digits] || {
      name: `Empresa CNPJ ${digits.slice(0,2)}.***.***/****-${digits.slice(12)}`,
      primary_color: '#2563eb',
      secondary_color: '#7c3aed',
      logo: `https://ui-avatars.com/api/?name=Empresa&background=2563eb&color=fff&size=128`,
    };
  }
  return { name: 'Usuário', primary_color: '#7c3aed', secondary_color: '#3b82f6', logo: '' };
}

// ===== Persistir branding no DB =====
export async function saveBranding(tenant_uuid, data) {
  if (isDBReady()) {
    const existing = await query('SELECT id FROM tenant_branding WHERE tenant_uuid=$1', [tenant_uuid]);
    if (existing && existing.length) {
      await query(
        `UPDATE tenant_branding SET company_name=$1,primary_color=$2,secondary_color=$3,logo_url=$4,cpf_cnpj=$5,updated_at=NOW() WHERE tenant_uuid=$6`,
        [data.company_name, data.primary_color, data.secondary_color, data.logo_url, data.cpf_cnpj, tenant_uuid]
      );
    } else {
      await query(
        `INSERT INTO tenant_branding (tenant_uuid,company_name,primary_color,secondary_color,logo_url,cpf_cnpj) VALUES($1,$2,$3,$4,$5,$6)`,
        [tenant_uuid, data.company_name, data.primary_color, data.secondary_color, data.logo_url, data.cpf_cnpj]
      );
    }
  }
}

export async function getBranding(tenant_uuid) {
  if (isDBReady()) {
    const rows = await query('SELECT * FROM tenant_branding WHERE tenant_uuid=$1', [tenant_uuid]);
    if (rows && rows.length) return rows[0];
  }
  return null;
}

// ===== Rotas Express =====
export function mountBrandingRoutes(app) {
  // POST /api/branding/lookup — Consulta CPF/CNPJ e retorna dados da empresa
  app.post('/api/branding/lookup', async (req, res) => {
    const { document } = req.body;
    if (!document) return res.status(400).json({ error: 'Documento obrigatório' });

    const { type, validated, digits } = identifyDoc(document);
    if (!validated) return res.status(400).json({ error: `Documento ${type === 'cpf' ? 'CPF' : 'CNPJ'} inválido`, type, validated: false });

    const company = lookupCompany(type, digits);
    res.json({
      type,
      validated: true,
      document: digits,
      company_name: company.name,
      primary_color: company.primary_color,
      secondary_color: company.secondary_color,
      logo_url: company.logo,
      is_cpf: type === 'cpf',
      is_cnpj: type === 'cnpj',
    });
  });

  // GET /api/branding/:tenant_uuid — Recupera branding do tenant
  app.get('/api/branding/:tenant_uuid', async (req, res) => {
    const branding = await getBranding(req.params.tenant_uuid);
    if (branding) return res.json(branding);

    // Fallback: dados genéricos
    res.json({
      company_name: 'Athena IA',
      primary_color: '#7c3aed',
      secondary_color: '#3b82f6',
      logo_url: 'https://ui-avatars.com/api/?name=Athena+IA&background=7c3aed&color=fff&size=128',
      cpf_cnpj: null,
    });
  });

  // POST /api/branding/save — Salva branding do tenant logado
  app.post('/api/branding/save', async (req, res) => {
    const { tenant_uuid, company_name, primary_color, secondary_color, logo_url, cpf_cnpj } = req.body;
    if (!tenant_uuid) return res.status(400).json({ error: 'tenant_uuid obrigatório' });

    await saveBranding(tenant_uuid, { company_name, primary_color, secondary_color, logo_url, cpf_cnpj });
    res.json({ status: 'ok', message: 'Branding salvo com sucesso' });
  });
}
