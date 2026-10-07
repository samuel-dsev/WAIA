# Continuidade — WAIA

Atualizado em 18/09/2026. Plano ativo: [WAIA_2.0.0.md](WAIA_2.0.0.md); sequência: [PLAN.md](PLAN.md).
Este relatório separa inspeção local, histórico de operação e trabalho ainda planejado.

## Integração YCloud — 07/10/2026

- Commit/push do conector concluídos com autorização: `9adaef0`, v1.12.0, HEAD e origin/dev confirmados iguais. Alterações anteriores de F2 ficaram fora do commit.
- Preparação de deploy: imagem v1.12.0 construída exclusivamente de git archive do commit aprovado. Auditoria detectou `proxy-addr` 2.0.7 (crítica, GHSA-jqcg-44mw-7w3h) e `ip-address` 10.5.0 (moderada). Correção compatível apenas no lockfile para 2.0.8 e 10.7.3, com versão candidata 1.12.1; `npm ci` e `npm audit --omit=dev` passaram com zero vulnerabilidades. Snapshot isolado com dependências corrigidas: 443 testes, 428 aprovados, 15 skips opt-in, zero falhas. Commit/push da correção autorizados em 07/10/2026; deploy ainda pendente de autorização específica.
- Acesso SSH inicialmente bloqueado pelo firewall restrito ao IP antigo. Após confirmação explícita, adicionada e sincronizada regra TCP 22 exclusiva ao IPv4 atual (/32), preservando as anteriores. Chave existente funcionou; nenhum cadastro ou rotação de chave foi necessário.
- Preflight remoto read-only em 07/10/2026: release atual `/opt/waia/releases/v1.10.6`, imagem antiga disponível; API/worker/PostgreSQL/Redis saudáveis e readiness interno 200. Backup `/opt/waia/backups/waia-backup-20261007T151620Z` com checksums de dump, mídia e manifesto aprovados; timers local/offsite ativos, entrega offsite não verificada nesta rodada. Banco com migrações 001–020. Nova release inclui 021/022 existentes em dev e 024 do conector, sem 023 de equipe/MFA. Deploy ainda não executado.

- Pedido explícito para integrar a YCloud à WAIA em produção. No navegador, número da Filaretti aparece conectado na YCloud; WABA ainda `In process`. Cadastro Filaretti criado no painel de produção como rascunho, sem ativação ou credenciais. O painel ainda não oferece YCloud.
- Preparado localmente o conector incremental v1.12.0: API key e assinatura no cofre por empresa, vínculo de número com finalidade/provedor validados, envio de texto/botões/listas, leitura, estados, preflight GET e callback separado `/webhook/ycloud/:webhookPublicId`. Mantidos Graph API/Meta e fluxo transacional/outbox existentes.
- Migração 024 amplia de modo aditivo os modos/regras da conexão. Histórico, ecos e grupos não entram na fila de IA. Mídia YCloud não suportada nesta entrega; sem promessa de sincronização de inbox/histórico ou conclusão da F5.
- Validação local: 447 testes, 431 pass, zero falhas, 16 skips opt-in. PostgreSQL 16 real no servidor de `waia-test`, banco temporário isolado: migrações 001–024 aplicadas; dois testes de vínculos Meta/YCloud, finalidades, readiness e isolamento aprovados em Node 22. Nenhuma migração aplicada ao banco existente de `waia-test` ou produção. Erros iniciais no harness SQL/limpeza foram corrigidos antes do resultado final.
- Validação adicional em snapshot do conector sobre HEAD, excluindo os arquivos e hunks anteriores de F2: 443 testes, 428 aprovados, 15 skips opt-in, zero falhas. Conector independente das alterações anteriores; lista de arquivos e procedimento em `docs/YCLOUD_FILARETTI.md`.
- Alterações preexistentes de F2/equipe/MFA preservadas. Elas não foram autorizadas como parte da release YCloud; o conjunto deve ser separado antes de commit/build de produção. Nenhum commit, push, deploy, webhook externo ou envio real realizado nesta implementação.
- Procedimento de cadastro e gates externos em [docs/YCLOUD_FILARETTI.md](docs/YCLOUD_FILARETTI.md). Commit/push somente do conector autorizados em 07/10/2026 após revisão de arquivos, versão e testes. Publicação ainda depende de autorização específica; então salvar credenciais pelo painel, configurar webhook e validar mensagem real + uso no celular.

## Estado atual confirmado localmente

- Checkout: `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`.
- Baseline funcional: v1.10.6, `497e511` (proteção da chave PIX).
- `main` e remoto foram atualizados com autorização para `707a46d`, merge da dev; árvores de conteúdo idênticas antes desta revisão. GitHub confirmou main como padrão.
- A diferença de ancestralidade main/dev é esperada; não fazer reset ou force push para eliminá-la.
- F0 versionada e enviada à dev com autorização: `40eeb9c`, v1.10.9. F1 autorizada e preparada como v1.11.0; commit/push explicitamente autorizados após apresentação do conjunto. Não é entrega nem deploy da 2.0.0.
- A VPS não foi consultada nesta rodada. Último deploy registrado: v1.10.6/497e511 em `/opt/waia/releases/v1.10.6`; pode ter mudado posteriormente.

## Base existente que deve ser preservada

- API e worker oficiais: `src/api.js`, `src/worker.js`, bootstrap `src/bootstrap/app-runtime.js`; `src/server.js` é legado.
- PostgreSQL como fonte de verdade; RLS forçada, role de aplicação restrita, contexto transacional e FKs por empresa. Redis/BullMQ, outbox, deduplicação, locks e retries.
- Usuários globais, vínculos com empresas, sessões opacas/CSRF, papéis de plataforma/administrador/operador e auditoria transacional.
- Configuração V2: rascunho, compilação, revisão imutável, readiness, preflight, simulador e ativação; fluxos declarativos e wizard de dez etapas.
- Meta por empresa/aplicativo, credenciais cifradas e callback `/webhook/meta/:webhookPublicId`; `/webhook` preservado por compatibilidade.
- OpenAI Responses API, chaves compartilhada/própria, consumo/limites; conversas com assumir/pausar/retomar e envio humano.
- Mídia privada com integridade, operações de pedidos/agenda/PIX, Google Sheets por empresa e monitoramento.

## Histórico condensado

| Marco | Resultado preservado |
|---|---|
| v1.1.0 / 00a0a09 | Baseline antigo; deixou de ser a main atual em 16/09/2026 |
| v1.2–1.8.3 | Contratos, onboarding, fluxos, Meta multiapp, painel, simulação e regressões de isolamento com empresa sintética |
| v1.9.0–1.9.1 | Hardening, homologação, artefato e preparação de produção |
| v1.10.0–1.10.1 | Infraestrutura publicada, alertas/backup/custódia; correção de checksum SQL LF/CRLF |
| v1.10.3–1.10.5 | Readiness por tipo de integração, preflight Sheets e agenda dinâmica da revisão ativa |
| v1.10.6 / 497e511 | PIX escalar validado, rotação e runtime falhando fechado; último deploy registrado |
| 16/09/2026 / 707a46d | Promoção autorizada da mesma base para main; nenhum deploy nessa promoção |

No canário registrado do Capitão Mor, Meta/OpenAI/Sheets passaram no preflight; empresa foi publicada/ativada. Menu, endereço, agenda, pedido pendente com comprovante e exportação Sheets foram exercitados; usuário confirmou a apresentação correta do PIX após rotação. Não houve pagamento real nesse teste controlado. A comprovação de uma segunda empresa real e da antiga janela de estabilização não consta como concluída; deve integrar os gates do novo piloto, sem impedir planejamento local.

Histórico do deploy v1.10.6: backup `waia-backup-20260909T012103Z` com verificação e cópia cifrada, 20 migrações descobertas, API/worker saudáveis, readiness e privacy 200, rollback preservado. Esses resultados vêm do registro de execução anterior, não de uma verificação atual da VPS.

## Operação e aceites úteis

- Produção registrada no Compose `waia-prod`, releases em `/opt/waia/releases`, symlink `/opt/waia/current`.
- Traefik/EasyPanel e dois n8n compartilham o host; não recriar/reiniciar sem escopo explícito.
- Aceites históricos: RPO 24h, RTO 4h, Samuel Felipe responsável, Google Drive cifrado, Discord, allowlist administrativa e custódia fora da VPS.
- Os aceites jurídicos/operacionais de 07/09 estão preservados em [docs/ACEITES_FASE_11.md](docs/ACEITES_FASE_11.md). São do piloto; revalidar para oferta pública.
- Procedimentos e cuidados de backup/restore/deploy: [docs/OPERACAO_RELEASE.md](docs/OPERACAO_RELEASE.md).

## Contratos e armadilhas que não podem se perder

- Sheets é posicional: `Agenda!A2:I`, `Configurações!A2:C`, `Pedidos!A:G`; cache válido permanece em falha transitória.
- Agenda versionada só materializa eventos Google válidos do próprio tenant quando módulo/integração estão habilitados.
- PIX fica no cofre como valor escalar; conteúdo estruturado/legado inválido é recusado. Não enviar chave ou comprovante à IA.
- Migrações aceitam equivalência LF/CRLF do mesmo SQL, não alterações de conteúdo em histórico aplicado.
- Executar Compose de produção dentro da release correta carregando o ambiente correto; `COMPOSE_FILE` absoluto não escolhe o `.env` por si só.
- Usar `docker compose exec`/`docker exec` para operação em container ativo; `compose run` já recriou dependências indevidamente no histórico.
- Backup sem versões necessárias do keyring não recupera credenciais. Não remover versões antigas ainda referenciadas.
- Suite local não substitui PostgreSQL/Redis reais nem testes externos; contagens antigas de testes foram removidas por não representarem o estado atual.

## Atualização documental desta rodada

- Criada especificação integral da 2.0.0, com F0–F9, APIs, dados, permissões, e-mail/MFA, billing, QR, conhecimento, inbox, privacidade, operação e matriz de testes.
- Substituídos planos antigos por índice e referência; resumido este relatório; runbook removido de cronologia de deploy antiga; aceites preservados.
- AGENTS atualizado para apontar ao plano vigente, mantendo fluxo de autorização e uso da dev/waia-test.
- PLAN passa a ser versionável; README aponta para a documentação vigente e não apresenta testes antigos como recentes.
- Validação desta rodada: consistência de versões, links locais e diff documental. Nenhuma suite funcional ou integração foi executada; nenhum runtime foi alterado.

## Próximo trabalho

F1 com gate local concluído. Arquivos, validações, versão 1.11.0 e mensagem apresentados; usuário autorizou commit/push em `dev`. F2 requer novo aceite. E-mail real/domínio e publicação continuam gates externos. A imagem dos serviços de `waia-test` permanece antiga; a validação executou o código atual em staging efêmero, sem substituir os serviços ou resetar volumes.

## F0 — início e fechamento em 16/09/2026

Registro histórico; fechamento posteriormente commitado/enviado como `40eeb9c`. As referências abaixo a pendências da F0 descrevem o momento da execução, superado pela seção F1 ao final.

- Pedido do usuário: começar a atualização da raiz; iniciada a primeira fase prevista, F0. Checkout `dev`, HEAD `497e511`; referência local main `707a46d` com árvore funcional idêntica. Remoto/VPS não consultados nesta fase.
- Preservadas alterações anteriores em `.gitignore`, `AGENTS.md`, `README.md`, `RELATORIO.md`, `docs/OPERACAO_RELEASE.md`, `implementações_finais.md`, packages, `PLAN.md` e especificação. Nenhum commit/push realizado.
- Inventário e decisões de API/portal, autorização efetiva, bootstrap e migração de identidade registrados em [ADR 001](docs/ADR_001_PORTAL_IDENTIDADE.md). Não foram criados placeholders nem alteradas as 20 migrações existentes.
- Baseline reproduzido em Node v24.18.0/npm 11.16.0, dependências locais instaladas: `npm test` com `RUN_POSTGRES_INTEGRATION=false` e `RUN_REDIS_INTEGRATION=false`: 424 testes, 412 pass, 0 fail, 12 skipped, duração 3782,8561 ms. Skips são integrações PostgreSQL/Redis opt-in. Esse resultado não comprova banco/Redis reais, serviços externos ou execução na imagem Node 22.
- Docker: tentativa de listar containers somente de `waia-test` falhou; pipe `docker_engine` não encontrado e aviso de acesso negado a config local do Docker. Não foi possível confirmar existência, saúde, imagem ou volumes do ambiente. Nenhum container/volume foi criado, removido ou reiniciado.
- Na retomada solicitada pelo usuário, Docker acessível fora do sandbox. Confirmados API/worker/PostgreSQL/Redis saudáveis, painel ativo e inicializadores/migrador encerrados com código 0. Redes `waia-test_internal` e `waia-test_egress`; volumes `waia-test_postgres_data`, `waia-test_redis_data` e `waia-test_media_data`. Nenhum volume foi alterado pela validação.
- API/worker usam `waia:1.9.1-phase12-local`, image ID `sha256:861616212b498b2cdd3e0bbcbebf988646895e830e8d67aabfd32e99324098ad`; package interno 1.9.1, Node v22.23.2. Não representam o checkout atual. A suíte do checkout atual passou nessa versão de Node em container temporário `--rm`, `--network none`, filesystem somente leitura e `/tmp` efêmero; `node --test --test-reporter=dot` terminou com código 0 (424 casos; flags PostgreSQL/Redis desabilitadas). Nenhum serviço existente foi substituído.
- Sondas somente leitura: 20 migrações no PostgreSQL; `waia_app` com `rolsuper=false` e `rolbypassrls=false`; RLS habilitada/forçada em `empresas`, `usuarios`, `usuarios_empresas` e `auth_sessions`; identidade/tenant aleatórios enxergam zero registros nessas tabelas; rollback e conexão reutilizada sem contexto residual. Redis retornou PONG; `/health/ready` retornou 200. Não foram inseridas fixtures ou executadas migrações.
- Gate F0 concluído: baseline reproduzível e ambiente conhecido sem afetar dados reais. Limites: sondas não substituem suíte completa opt-in, ensaio de migração do código atual, testes de dois cadastros da F1, carga ou fornecedores reais. Tarifas/volume e capacidade medida continuam pendentes nas fases correspondentes, sob responsabilidade do titular do WAIA. F1 não iniciada.
- Versão de fechamento documental: 1.10.9 nos dois manifests. Mensagem sugerida para aprovação: `v1.10.9 - consolida plano WAIA 2.0.0 e fecha baseline F0`.

## F1 — contas e empresas, fechamento local em 18/09/2026

- Autorização explícita recebida após commit/push da F0. Implementação incremental no checkout principal `dev`, versão preparada 1.11.0. Após apresentação dos 33 arquivos, validações e mensagem, usuário autorizou commit/push; F2 não iniciada.
- Portal mínimo com cadastro, login/logout, confirmação, reenvio, recuperação/troca de senha, perfil, criação e retomada de empresa. Superfícies `/api/account/v1` e `/api/app/v1` separadas do admin. Contas desligadas por padrão; modo fake restrito a teste/desenvolvimento. Adapter HTTP preparado, sem fornecedor/domínio real homologado.
- Migrações 021/022 aplicadas no `waia-test`, sem alterar 001–020, apagar volumes ou substituir imagens dos serviços. Sessões com audience, verificação, tokens de uso único, outbox cifrada, proprietário explícito e auditoria. Empresa, vínculo, proprietário, rascunho V2 e progresso criados atomicamente, com limite e idempotência por usuário. Nenhuma atribuição automática de proprietário a empresa legada.
- Proteções: origem exata, cookie HTTPOnly/SameSite, CSRF, rate limit compartilhado com Redis, RLS por identidade e revalidação de vínculos. Poder global não passa para sessão customer. Reset revoga sessões administrativas e de cliente; MFA legado é preservado e impede login público até a F2.
- Regressão host Node 24: **431 testes, 417 aprovados, 0 falhas, 14 skips** (integrações opt-in). Mesma suíte em Node 22.23.2 no Docker, `NODE_ENV=test`, flags opt-in desligadas: código de saída 0. O primeiro harness Docker herdou ambiente production e omitiu arquivos de infraestrutura; corrigido o harness, a regressão passou, sem mudança funcional para contornar testes.
- Integração específica F1, Node 22 + PostgreSQL/Redis reais: **15 testes aprovados, 0 falhas, 0 skips**. Cobertura: dois cadastros, duplicidade concorrente, e-mail não confirmado, origem/CSRF/mass assignment, uso único/expiração de token, rollback de auditoria, provisionamento concorrente e rascunho válido, RLS/pool reutilizado, retomada, cookie, audience, revogação e limite distribuído com falha fechada. Um erro de formato do rascunho (`modules` deve ser lista) foi detectado e corrigido antes do resultado final.
- Navegador local: cadastro, login, confirmação fake, criação/retomada da empresa e logout exercitados. Corrigidos foco em campo visível e reconhecimento do link de confirmação na aba já aberta. Screenshot desktop inspecionado. Tentativa de viewport 390px não foi aplicada pelo navegador (largura efetiva 1265px); aceitação visual mobile permanece sem comprovação nesta rodada.
- Build local concluído: `waia:1.11.0-f1-local`, image config `sha256:bcef6105d5bc150ed0bee9471c082a3e483be97fbaa093e86454138e1421c4be`. Portal incluído no artefato; `npm ci --omit=dev` terminou sem vulnerabilidades reportadas pelo comando. Imagem não implantada.
- Preview efêmero encerrado. Removidas somente uma conta e uma empresa sintéticas criadas para UI, além dos scripts temporários locais; testes automatizados limpam seus próprios UUIDs. API/worker/PostgreSQL/Redis do `waia-test` permaneceram saudáveis, painel ativo e volumes preservados. Nenhuma mensagem externa, VPS, túnel ou produção nesta fase.
- Operação, parâmetros globais, contrato de e-mail e rollback: [CONTAS_CLIENTE_F1.md](docs/CONTAS_CLIENTE_F1.md). Gate técnico local F1 concluído; exposição pública exige provedor/domínio, termos finais e gates comerciais posteriores. Não comprova entrega real de e-mail, carga, todas as integrações legadas opt-in ou produto 2.0.0 completo.

### Conjunto preparado para commit

- Infraestrutura/metadados: `.gitignore`, `.dockerignore`, `.env.example`, `Dockerfile`, `docker-compose.yml`, `infra/caddy/Caddyfile`, `package.json`, `package-lock.json`.
- Continuidade: `PLAN.md`, `RELATORIO.md`, `WAIA_2.0.0.md`, `docs/ADR_001_PORTAL_IDENTIDADE.md`, `docs/CONTAS_CLIENTE_F1.md`.
- Banco: `db/migrations/021_customer_accounts.sql`, `db/migrations/022_account_identity_audit.sql`.
- Runtime: `src/bootstrap/app-runtime.js`, `src/config.js`, `src/infra/postgres/transaction.js`, `src/modules/auth/repositories.js`, `src/modules/auth/token-codec.js`, `src/integrations/email/transport.js`.
- Contas: `src/modules/accounts/account-repository.js`, `account-service.js`, `errors.js`, `http.js`, `rate-limiter.js`, `runtime.js` (todos no mesmo diretório).
- Portal: `portal/index.html`, `portal/styles.css`, `portal/app.js`.
- Testes: `test/accounts.test.js`, `test/accounts-postgres.test.js`, `test/accounts-redis.test.js`.
- Mensagem proposta: `v1.11.0 - adiciona contas de cliente e provisionamento de empresas`.
