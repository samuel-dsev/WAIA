import "dotenv/config";
import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { randomUUID } from "node:crypto";
import { createPostgresPool, closePostgresPool } from "../src/infra/postgres/pool.js";
import { withPlatformTransaction } from "../src/infra/postgres/transaction.js";
import { hashPassword } from "../src/modules/auth/password.js";

class MutedOutput extends Writable {
  constructor(target) { super(); this.target = target; this.muted = false; }
  _write(chunk, encoding, callback) { if (!this.muted) this.target.write(chunk, encoding); callback(); }
}

function validateEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email) || email.length > 320) throw new Error("E-mail inválido.");
  return email;
}

function validateName(value) {
  const name = String(value || "").trim();
  if (name.length < 2 || name.length > 160) throw new Error("Nome inválido.");
  return name;
}

async function askSecret(readline, muted, prompt) {
  muted.target.write(prompt);
  muted.muted = true;
  try { return await readline.question(""); }
  finally { muted.muted = false; muted.target.write("\n"); }
}

const muted = new MutedOutput(output);
const readline = createInterface({ input, output: muted, terminal: Boolean(input.isTTY) });
let pool;
try {
  const email = validateEmail(process.env.ADMIN_EMAIL || await readline.question("E-mail do administrador: "));
  const name = validateName(process.env.ADMIN_NAME || await readline.question("Nome do administrador: "));
  const password = await askSecret(readline, muted, "Senha (12 a 256 caracteres): ");
  const confirmation = await askSecret(readline, muted, "Confirme a senha: ");
  if (password !== confirmation) throw new Error("As senhas não conferem.");
  const passwordHash = await hashPassword(password);
  pool = createPostgresPool({ allowExitOnIdle: true });
  await withPlatformTransaction(pool, {}, async ({ client }) => {
    const existing = await client.query("SELECT id FROM usuarios WHERE email = $1 AND deleted_at IS NULL", [email]);
    if (existing.rowCount) throw new Error("Já existe um usuário com esse e-mail.");
    await client.query(
      `INSERT INTO usuarios (id, email, nome, password_hash, papel_plataforma, status)
       VALUES ($1,$2,$3,$4,'administrador','ativo')`,
      [randomUUID(), email, name, passwordHash],
    );
  });
  output.write("Administrador da plataforma criado com sucesso.\n");
} catch (error) {
  output.write(`Não foi possível criar o administrador: ${error?.message || "falha interna"}\n`);
  process.exitCode = 1;
} finally {
  readline.close();
  if (pool) await closePostgresPool(pool);
}
