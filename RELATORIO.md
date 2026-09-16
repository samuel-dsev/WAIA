# Continuidade — WAIA

Atualizado em 16/09/2026. Plano ativo: [WAIA_2.0.0.md](WAIA_2.0.0.md); sequência: [PLAN.md](PLAN.md).
Este relatório separa inspeção local, histórico de operação e trabalho ainda planejado.

## Estado atual confirmado localmente

- Checkout: `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`.
- Baseline funcional: v1.10.6, `497e511` (proteção da chave PIX).
- `main` e remoto foram atualizados com autorização para `707a46d`, merge da dev; árvores de conteúdo idênticas antes desta revisão. GitHub confirmou main como padrão.
- A diferença de ancestralidade main/dev é esperada; não fazer reset ou force push para eliminá-la.
- A revisão anterior preparou v1.10.7; o início da F0 preparou v1.10.8 e seu fechamento prepara v1.10.9, somente documentação e metadados de versão. Não é entrega nem deploy da 2.0.0.
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

F0 concluída. Aguardar confirmação explícita para commit/push do conjunto documental em `dev`; depois obter autorização própria para F1. Decisões externas restantes constam na seção 20 da especificação. Na F1, validar o código novo em PostgreSQL/Redis reais e planejar atualização do `waia-test` sem reset dos volumes; a imagem atual desse ambiente é antiga.

## F0 — início e fechamento em 16/09/2026

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
