# WAIA - Plataforma multiempresa de atendimento WhatsApp

Este repositório evolui a demonstração do chatbot do Capitão Mor para uma plataforma SaaS multiempresa. A base continua em Node.js com ES Modules, Express, WhatsApp Cloud API e OpenAI Responses API, com API central, worker, painel administrativo, PostgreSQL e Redis. O adaptador multiempresa de Google Sheets existe e é testado isoladamente, mas sua ligação ao runtime oficial ainda está pendente.

O `src/server.js` permanece como entrada legada da demonstração. A operação oficial usa:

- `npm start`: alias do executável oficial da API.
- `npm run start:api`: webhook público, API administrativa, páginas legais e health checks.
- `npm run start:worker`: dispatcher de outbox, fila Redis/BullMQ, locks, retries e processamento de mensagens.
- `npm run start:legacy`: demonstração antiga do Capitão Mor, sem garantias SaaS.
- `panel/`: painel administrativo estático consumindo `/api/admin`.

A entrada legada, quando necessária, usa exclusivamente `CAPITAO_MOR_WHATSAPP_ACCESS_TOKEN` e `CAPITAO_MOR_WHATSAPP_PHONE_NUMBER_ID`. A API e o worker multiempresa não aceitam token ou número Meta globais; resolvem ambos pelo tenant e pelo cofre de credenciais.

## Arquitetura

Fluxo principal:

1. A Meta envia eventos para `https://api.suaplataforma.com/webhook`.
2. A API valida assinatura, extrai `metadata.phone_number_id`, resolve a empresa e persiste mensagem/status no PostgreSQL.
3. A API grava um job no outbox na mesma transação e responde rapidamente à Meta.
4. O worker publica o outbox no Redis, processa jobs com lock por conversa e envia a resposta pelo número correto.
5. Conversas, mensagens, pedidos, agendamentos, consumo de IA, logs e auditoria ficam isolados por `empresa_id`.

PostgreSQL é a fonte de verdade. Redis é usado para fila, concorrência, locks e rate limiting. Segredos recuperáveis ficam criptografados em repouso com AES-256-GCM e chave mestra fora do banco.

## Desenvolvimento local

Instale dependências:

```bash
npm install
```

Execute os testes:

```bash
npm test
```

Teste de carga sintético, sem rede e sem banco real:

```bash
npm run load:test
```

Para a API/worker oficiais é necessário PostgreSQL e Redis. Sem credenciais externas reais, a plataforma ainda inicia desde que a infraestrutura e segredos internos estejam configurados. Meta e OpenAI falham de forma isolada quando não configuradas; Google Sheets ainda precisa ser ligado ao runtime oficial.

## Variáveis

Copie `.env.example` para `.env` e preencha valores reais fora do Git.

Principais variáveis:

- `INFRASTRUCTURE_MODE=postgres`
- `POSTGRES_USER` e `POSTGRES_PASSWORD`: papel owner usado somente por bootstrap, migrações e manutenção
- `DATABASE_APP_USER` e `DATABASE_APP_PASSWORD`: papel restrito usado pela API e pelo worker
- `DATABASE_MIGRATOR_URL`: necessária apenas ao executar migrações fora do Compose
- `DATABASE_URL`: necessária apenas ao executar API, worker, seed ou administração fora do Compose
- `REDIS_URL`
- `SESSION_PEPPER`
- `MASTER_KEYRING`
- `WHATSAPP_VERIFY_TOKEN`
- `META_APP_SECRET`
- `OPENAI_API_KEY`, se usar chave OpenAI compartilhada
- `API_DOMAIN` e `PANEL_DOMAIN`
- `POSTGRES_PASSWORD`

`MASTER_KEYRING` deve ser um JSON com versão ativa e chaves base64, por exemplo com valores gerados fora do repositório:

```json
{"activeVersion":"v1","keys":{"v1":"<base64-32-bytes>"}}
```

Não coloque tokens Meta, chaves OpenAI, senhas, PIX real ou arquivos de service account em seeds, logs, documentação ou código.

## Docker Compose

Subir a stack inicial:

```bash
docker compose up -d --build
```

Serviços:

- `caddy`: único serviço público, publica portas `80` e `443`.
- `api`: Express em rede interna, exposto pelo Caddy.
- `worker`: consumidor de jobs.
- `panel`: Nginx servindo a aplicação estática.
- `postgres`: volume persistente, sem porta pública.
- `redis`: volume persistente, sem porta pública.

O Compose não repassa `POSTGRES_PASSWORD` nem `DATABASE_MIGRATOR_URL` à API ou ao worker. O serviço `db-init` mantém a propriedade do banco e dos objetos com o owner, remove `CREATE`, `TEMP`, superusuário e bypass de RLS do papel da aplicação, e concede somente privilégios operacionais.

Endpoints esperados:

- `https://api.suaplataforma.com/webhook`
- `https://api.suaplataforma.com/api/admin`
- `https://api.suaplataforma.com/privacy`
- `https://api.suaplataforma.com/data-deletion`
- `https://painel.suaplataforma.com`

## Banco

Executar migrações:

```bash
docker compose run --rm migrate
```

Seed demonstrativo do Capitão Mor:

```bash
docker compose run --rm api npm run db:seed
```

Criar o primeiro administrador:

```bash
docker compose run --rm api npm run admin:create
```

O comando pede senha interativamente e não possui senha padrão versionada.

## Cadastro de empresa

Uma segunda empresa deve ser criada por configuração, sem duplicar projeto:

1. Criar empresa no painel.
2. Configurar identidade, timezone, módulos, menu, catálogo, eventos, serviços, horários e pagamentos.
3. Vincular `phone_number_id` em `Números WhatsApp`.
4. Cadastrar credencial Meta no cofre com provider `meta` e finalidade `whatsapp:<numeroWhatsappId>`.
5. Configurar IA com chave compartilhada ou credencial própria.
6. Definir limites mensais e ativar a empresa.

Não há condicionais por nome de empresa no núcleo multiempresa.

## Operação

Backup PostgreSQL no host da VPS:

```bash
sh scripts/backup-postgres.sh
```

Restauração:

```bash
sh scripts/restore-postgres.sh ./backups/waia-postgres-YYYYMMDDTHHMMSSZ.dump
```

Atualização:

```bash
docker compose pull
docker compose up -d --build
docker compose run --rm migrate
```

Rollback: restaurar a imagem/commit anterior, subir a stack anterior e restaurar backup se a migração aplicada não for compatível.

## Segurança

- Validação de assinatura Meta preservada.
- Sessões administrativas opacas, cookies `HttpOnly`, `Secure` em produção e CSRF em mutações.
- Autorização aplicada no backend por papel e vínculo com empresa.
- RLS habilitado no PostgreSQL com contexto transacional; o papel da aplicação não possui DDL, propriedade dos objetos, `CREATE`, `TEMP` ou `BYPASSRLS`.
- Mutações administrativas e auditoria são atômicas; falha ao auditar reverte a alteração principal.
- API e painel mascaram segredos.
- Logs estruturados usam sanitização.
- Health público é mínimo; diagnósticos detalhados exigem autenticação administrativa.

## Validação

Comandos executados nesta continuidade:

- `npm test`: 143 testes aprovados e 2 testes PostgreSQL opcionais ignorados sem banco.
- `npm run load:test`: cenários sintéticos de 5, 20 e 100 tenants, picos distribuídos e tenant volumoso.
- `docker compose -p waia-today config --quiet`: configuração válida com segredos sintéticos.
- Migrações e seed executados em PostgreSQL 16 real; 10 migrações descobertas.
- Testes reais comprovaram que `waia_app` não executa DDL, não possui `CREATE`/`TEMP`/`BYPASSRLS`, respeita o tenant transacional e mantém a capacidade atômica da agenda.
- API e worker iniciados em modo `production` com PostgreSQL/Redis reais; ambos saudáveis e `/health/ready` retornou `200`.

As chamadas externas reais da Meta, OpenAI e Google não fizeram parte desta validação e continuam dependendo de ambiente e credenciais autorizados.
