import { totp } from '../modules/auth/totp.js';

export const LOCAL_TEST_ORIGIN = 'http://127.0.0.1:5035';
export const LOCAL_TEST_CONTAINER = 'waia-test-v2-preview';
export const LOCAL_TEST_NETWORK = 'waia-test_v2_internal';
const adminEmail = 'admin.local@waia.example';
const linkPurposes = new Set(['activate', 'reset', 'verify']);
const noticePurposes = new Set(['mfa_changed', 'password_changed']);
const invalid = () => new Error('Dados locais de teste inválidos; nenhum valor foi exportado.');

function syntheticEmail(value) {
  if (typeof value !== 'string' || value.length > 254
    || !/^[A-Za-z0-9][A-Za-z0-9._+-]*@(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\.)+example$/u.test(value)) throw invalid();
  return value;
}
function password(value) {
  // Existing preview passwords are randomly generated hex/base64url. Do not
  // turn arbitrary user input or Markdown into a credential handoff document.
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{12,256}$/u.test(value)) throw invalid();
  return value;
}
function mfaSecret(value) {
  if (typeof value !== 'string' || !/^[A-Z2-7]{32}$/u.test(value)) throw invalid();
  return value;
}

export function assertLocalTestPreview(container, network) {
  if (container?.Name !== `/${LOCAL_TEST_CONTAINER}` || container.State?.Running !== true
    || container.Config?.Labels?.['waia.preview'] !== 'v2-local'
    || network?.Name !== LOCAL_TEST_NETWORK || network.Internal !== true
    || Object.keys(container.HostConfig?.PortBindings || {}).length !== 0
    || Object.keys(container.NetworkSettings?.Networks || {}).length !== 1
    || !container.NetworkSettings.Networks[LOCAL_TEST_NETWORK]) throw invalid();
  const settings = {};
  for (const entry of container.Config.Env || []) {
    if (typeof entry !== 'string' || !entry.includes('=')) throw invalid();
    const index = entry.indexOf('='), key = entry.slice(0, index);
    if (Object.hasOwn(settings, key)) throw invalid();
    settings[key] = entry.slice(index + 1);
  }
  let database;
  try { database = new URL(settings.DATABASE_URL); } catch { throw invalid(); }
  if (settings.NODE_ENV !== 'development' || settings.ACCOUNT_EMAIL_MODE !== 'fake'
    || settings.CUSTOMER_PORTAL_ORIGIN !== LOCAL_TEST_ORIGIN
    || settings.PANEL_ORIGIN !== LOCAL_TEST_ORIGIN
    || !['postgres:', 'postgresql:'].includes(database.protocol)
    || database.hostname !== 'v2-postgres' || database.pathname !== '/waia_v2_app'
    || database.username !== 'waia_v2_app') throw invalid();
  // Never return environment values, infrastructure credentials or cookies.
  return { container: LOCAL_TEST_CONTAINER, origin: LOCAL_TEST_ORIGIN };
}

export function localMfaCode(secret, now = new Date()) {
  mfaSecret(secret);
  const time = new Date(now).getTime();
  if (!Number.isFinite(time) || time < 0) throw invalid();
  let bits = 0, value = 0;
  const bytes = [];
  for (const char of secret) {
    value = (value << 5) | 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char); bits += 5;
    if (bits >= 8) { bits -= 8; bytes.push((value >>> bits) & 255); }
  }
  const counter = Math.floor(time / 30_000);
  return { code: totp(Buffer.from(bytes), counter), expiresAt: new Date((counter + 1) * 30_000).toISOString() };
}

export function localAccessDocument({ bootstrap, users, mfa }) {
  if (typeof bootstrap !== 'string' || !users || Array.isArray(users) || typeof users !== 'object') throw invalid();
  const rows = bootstrap.split(/\r?\n/u).filter(line => line.startsWith('V2_PREVIEW_ADMIN_PASSWORD='));
  if (rows.length !== 1) throw invalid();
  const adminPassword = password(rows[0].slice('V2_PREVIEW_ADMIN_PASSWORD='.length));
  const secret = mfaSecret(mfa?.secret);
  const accounts = Object.entries(users).sort(([a], [b]) => a.localeCompare(b));
  if (!accounts.length || accounts.length > 50) throw invalid();
  for (const [email, saved] of accounts) { syntheticEmail(email); password(saved); }
  const text = [
    '# Acessos sintéticos — teste local WAIA', '',
    'Arquivo privado. Contém senhas e chave MFA somente do ambiente fictício local. Não publicar, compartilhar nem versionar.', '',
    `Painel administrativo: ${LOCAL_TEST_ORIGIN}/panel/`,
    `Portal cliente: ${LOCAL_TEST_ORIGIN}/portal/`, '',
    `Administrador: \`${adminEmail}\``, `Senha existente: \`${adminPassword}\``, '',
    'O administrador exige MFA real. No autenticador, adicione uma conta TOTP WAIA com a chave abaixo (SHA-1, seis dígitos, 30 segundos).',
    `Chave MFA existente: \`${secret}\``, '',
    'Alternativa local: execute o modo code do helper e abra CODIGO_MFA_LOCAL.txt. Um código já utilizado não pode ser repetido; aguarde o próximo período de 30 segundos.', '',
    '## Clientes fictícios', '',
    ...accounts.map(([email, saved]) => `- E-mail: \`${email}\` · senha salva: \`${saved}\``), '',
    'Estas são as credenciais já salvas na preparação. Se você alterar uma senha, este arquivo poderá ficar desatualizado; o helper não redefine senhas, MFA, identidades ou permissões.', '',
    'Para ativação/recuperação fake, gere EMAILS_TESTE_LOCAL.md pelo modo mail após emitir o link no painel/portal. Links podem expirar ou ter sido consumidos; solicite outro quando necessário.', '',
    'As conexões externas permanecem ausentes e os opcionais de cliente seguem fechados. Salvar rascunho é diferente de publicar/ativar atendimento.', '',
  ].join('\n');
  return { text, otpUri: `otpauth://totp/WAIA:${encodeURIComponent(adminEmail)}?secret=${secret}&issuer=WAIA&algorithm=SHA1&digits=6&period=30` };
}

export function localMailDocument(messages) {
  if (!Array.isArray(messages) || messages.length > 1000) throw invalid();
  const links = [];
  for (const message of messages) {
    if (!message || typeof message !== 'object' || Array.isArray(message)
      || Object.keys(message).some(key => !['to', 'purpose', 'url', 'idempotencyKey'].includes(key))) throw invalid();
    const email = syntheticEmail(message.to);
    if (noticePurposes.has(message.purpose)) {
      if (message.url !== undefined) throw invalid();
      continue;
    }
    if (!linkPurposes.has(message.purpose) || typeof message.url !== 'string') throw invalid();
    let url;
    try { url = new URL(message.url); } catch { throw invalid(); }
    if (url.origin !== LOCAL_TEST_ORIGIN || url.pathname !== '/portal/' || url.search
      || url.username || url.password || !new RegExp(`^#${message.purpose}=[A-Za-z0-9_-]{43}$`, 'u').test(url.hash)
      || message.url !== `${LOCAL_TEST_ORIGIN}/portal/${url.hash}`) throw invalid();
    links.push({ email, purpose: message.purpose, url: url.href });
  }
  return [
    '# E-mails fictícios — teste local WAIA', '',
    'Arquivo privado com links de uso único. Nenhum e-mail real foi enviado. Não publicar, compartilhar nem versionar.', '',
    'Abra somente o link da finalidade e do destinatário desejados. Links antigos podem estar consumidos, expirados ou invalidados por reenvio; emita um novo pelo painel/portal e gere este arquivo novamente.', '',
    ...(links.length ? links.map(link => `- ${link.email} · ${link.purpose}: [Abrir link local](${link.url})`) : ['Nenhum link de ativação/recuperação/verificação foi encontrado na caixa fictícia.']), '',
  ].join('\n');
}
