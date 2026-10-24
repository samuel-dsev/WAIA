# M0 — baseline e ambiente isolado da 2.0.0

23/10/2026, America/Sao_Paulo. Checkout principal `new`, HEAD de origem
`3b8a295514bfe75884d82e2e9238a76475783dc2`. Candidata local **1.23.3**;
2.0.0 continua futura. Este é o registro de fechamento inicial da M0.
Posteriormente, o usuário autorizou o commit **local** 89d46af e a M1;
resultados atuais em [M1_IDENTIDADE.md](M1_IDENTIDADE.md). Push/publicação não autorizados.

## Escopo e trabalho preservado

O início encontrou manifests 1.23.2, 27 arquivos rastreados modificados,
`.tmp/` e seis arquivos de equipe/MFA não rastreados, além da migração 023.
Nenhum reset/stash, troca de branch ou worktree foi utilizado.

| Conjunto anterior | Tratamento M0 |
|---|---|
| `.env.example`, Compose principal, bootstrap/config, auth/accounts/admin, panel/portal e `test/accounts-postgres.test.js` | Preservados; não são implementação nova da M0 |
| `023_team_and_mfa.sql`, `team-service.js`, `identity-security.js`, `totp.js`, `portal/security-team.js`, `test/identity-security.test.js`, `test/team-postgres.test.js` | Preservados e testados como baseline; não aprovam gestão de equipe pelo cliente |
| PLAN, RELATORIO, especificação, ADR/F1 e registro de pausa Business | História preservada; documentos de continuidade recebem o resultado atual |
| `.tmp/` | Evidências locais, fora do conjunto proposto para commit |

Arquivos próprios da M0: `.dockerignore`, `.gitignore`, Dockerfile,
`.github/workflows/ci.yml`, `infra/compose.v2-test.yml`,
`infra/postgres/init-v2-test.sh`, `scripts/{check-syntax,m0-schema-check,prepare-v2-environment,validate-v2-environment}.mjs`
e este runbook. Manifests e documentos de continuidade têm alterações incrementais.
O lock atualiza somente `body-parser` 2.3.0 → 2.4.0 e sua dependência `qs`
6.16.0 → 6.16.1, além da versão. A auditoria inicial detectou
[GHSA-27r3-jxmh-p828](https://github.com/expressjs/body-parser/security/advisories/GHSA-27r3-jxmh-p828).

As imagens/testes desta rodada usam o checkout completo, incluindo o trabalho
preexistente não commitado. O conjunto a versionar precisa considerar essas
dependências (023 e arquivos de equipe/MFA); não aprovar publicação ou inclusão
de todos os arquivos apenas porque passaram no baseline. CI remota só pode ser
declarada aprovada depois de testar o commit efetivamente selecionado.

## Alvos e isolamento

O Compose exclusivo usa o mesmo projeto **waia-test**, carregando apenas
`infra/compose.v2-test.yml`. Não sobrepor o Compose principal nem usar
`--remove-orphans`, `down -v`, seed ou restore.

| Recurso | Alvo da nova instalação |
|---|---|
| PostgreSQL 16 | Serviço `v2-postgres`, cluster separado do PostgreSQL anterior |
| Bases técnicas | `waia_v2_empty` e `waia_v2_upgrade`; só fixtures de testes |
| Base para as próximas fases | `waia_v2_app`, schema migrado e zero dados de negócio |
| Papéis | `waia_v2_bootstrap` só inicializa o cluster; migrador `waia_v2_owner` e aplicação `waia_v2_app` sem SUPERUSER/BYPASSRLS/CREATEDB/CREATEROLE |
| Redis 7 | Serviço exclusivo `v2-redis`, DB 0; fila reservada `waia-v2-synthetic` |
| Mídia | Volume `waia-test_v2_media_data`, proprietário 1000, modo 700 |
| Persistência | `waia-test_v2_postgres_data`, `waia-test_v2_redis_data` |
| Rede | Somente `waia-test_v2_internal`, `internal: true`, sem portas publicadas |
| Segredos globais sintéticos | `.secrets/v2-test.env`, ignorado/excluído do build; valores aleatórios próprios, sem rotação na reexecução |
| Aplicação | API, worker e notificadores ausentes deste Compose; nenhum endpoint público |

Pepper/material de chave independentes ficam reservados no arquivo protegido;
não estão ligados a um runtime de atendimento nesta fase. Não há credenciais
de provedores, contas de clientes ou bootstrap administrativo importados.
Bootstrap do administrador e formato/configuração do keyring serão integrados
no alvo correto antes de ligar a aplicação, nas etapas autorizadas.

Redis dedicado isola também os prefixos fixos `waia:conversation-lock:`,
`waia:tenant-slots:`, `waia:tenant-rate:`, `waia:auth-rate:`,
`waia:account-rate:`, `waia:metrics:*`, `waia:worker:heartbeat:*` e BullMQ.
Alterar só REDIS_QUEUE_NAME seria insuficiente. A mídia antiga nunca é montada.

O `waia-test` anterior estava parado: imagens API/worker 1.9.1 e volumes
anteriores preservados. Somente seu PostgreSQL foi iniciado para ler metadados
do ledger, depois parado novamente. Foram encontrados **23 registros, 001–023**;
nenhuma migração ou fixture foi aplicada ali. Esse resultado local não descreve
o banco da VPS, que não foi acessada.

## Schema e estratégia da 023

| Migrações | Inventário/decisão |
|---|---|
| 001–020 | Base histórica, arquivos preservados |
| 021–022 | Contas/auditoria já existentes |
| 023 | Trabalho local não rastreado; já presente no ledger do waia-test antigo; dependência do runtime atual |
| 024–026 | YCloud, grupos e pausa Business; ausentes no ledger local antigo |

Não editar SQL já aplicado. O runner compara SHA256 com normalização LF/CRLF;
as duas bases técnicas validam todos os 26 arquivos contra o ledger. A aplicação
da 023 somente no alvo sintético **não autoriza** migrar a instalação anterior.

O ensaio vazio aplica 26 arquivos. O ensaio de upgrade cria outro schema
sintético com 001–022 + 024–026, depois aplica somente 023. Os schemas finais,
policies, constraints, índices, funções/agregados e triggers são equivalentes;
reaplicação executa zero migrações. Hash do snapshot:
`a7f787cfc326734dd7aef9828e4ad73a39f8c5f1c2629429da791320aa8599a8`.

O código local consulta colunas/tabelas da 023 mesmo com contas desativadas.
Nunca apontar esse runtime para schema sem 023. M1 revisará audience,
revogação/MFA e bloqueio do signup/equipe/ownership cliente. Não expor as rotas
atuais sob a suposição de que a M0 já resolve esses contratos.

## Procedimento reproduzível

Os comandos usam o checkout atual e acompanham a fase vigente (M1: schema 27).
As contagens históricas da M0 pertencem ao snapshot 89d46af; não confundir com
os resultados novos do runbook M1.

No checkout principal, branch `new`, com Docker Desktop disponível:

```powershell
rtk proxy node scripts/prepare-v2-environment.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs
```

O primeiro comando gera segredos apenas quando ausentes, constrói a imagem de
validação e inicia somente PostgreSQL/Redis v2 e inicializa a mídia. O segundo
confere schemas, roda os testes selecionados no banco técnico, migra a base de
desenvolvimento sem seed e comprova ausência de dados de negócio, mídia e egress.
Não imprimir `docker compose config` completo, env ou inspect completo dos
containers: contêm valores de conexão sintéticos. Use `config --quiet` e
metadados filtrados.

```powershell
rtk proxy docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 -e NODE_ENV=test -e RUN_POSTGRES_INTEGRATION=false -e RUN_REDIS_INTEGRATION=false waia:v2-test-local npm test
rtk proxy docker run --rm --network none --read-only --tmpfs /tmp:mode=1777 waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy docker run --rm --read-only --tmpfs /tmp:mode=1777 -e npm_config_cache=/tmp/npm-cache waia:v2-test-local npm audit --omit=dev
```

O harness de schema aceita bases novas ou duas bases completas com ledger
exato/checksums e sem dados de negócio (`existing-verified`). Recusa estado
parcial, misto ou inesperado; não apaga/reinicializa alvos. Reexecutar em estado
completo não refaz o ensaio vazio. Para o ensaio vazio local foi usado um
PostgreSQL efêmero com tmpfs e a mesma inicialização, removido ao terminar;
o job de CI sempre fornece cluster sintético novo. Nunca limpar volumes
persistentes para reproduzir esse ensaio.

PostgreSQL/Redis v2 ficam disponíveis internamente para continuidade. Não há URL
de interface na M0. Para parar apenas esses serviços, preservando volumes:

```powershell
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml stop v2-postgres v2-redis
```

## Resultados e limites

Conjunto selecionado para commit local após autorização: 20 arquivos, incluindo
a 023 caracterizada como schema e apenas o ajuste da fixture de revogação de
vínculo protegido por ownership. A implementação de equipe/MFA e os demais
arquivos de produto anteriores permanecem fora deste commit. A CI e o validador
versionados usam accounts-postgres e três arquivos Redis, sem depender do teste
de equipe ainda não incorporado. Snapshot exato do índice exportado sem alterar
o checkout: **601 testes, 580 aprovados, 21 skips, zero falhas**; integrações
PostgreSQL/Redis: **17 aprovadas, zero skips/falhas**; schema e isolamento
aprovados. Evidências: `.tmp/m0/commit-baseline.tap`,
`commit-integrations.log` e `commit-build.log`. Os números abaixo descrevem
o checkout completo da rodada inicial e não devem ser confundidos com esse
conjunto menor e coerente selecionado para versionamento.

- Node **22.23.2**: 605 testes, **583 aprovados, 22 skips opt-in, zero falhas**.
- Sintaxe em src/scripts/test/panel/portal: **288 arquivos**, aprovada.
- `npm ci` na imagem aprovado; auditoria final **zero vulnerabilidades**.
- Build padrão `waia:v2-m0-runtime-local` aprovado; panel/portal presentes,
  testes/segredos/infra ausentes do artefato de runtime. Imagem local:
  `sha256:d7cccf5b969e69f085618c310ab0d721ca5ed3918a2b8ae8e6f77821802a4370`.
  É uma imagem de desenvolvimento do checkout completo, sem promoção/deploy.
- PostgreSQL/Redis reais: **30 testes aprovados, zero skips/falhas**, nos arquivos
  accounts-postgres, team-postgres, accounts-redis, redis-integration e
  ai-reply-delay-redis. São caracterização do legado, sem declarar M1 entregue.
- Schema novo e upgrade tardio 023 aprovados em cluster efêmero; reexecução
  verificada nas bases persistentes. Ledger/checksums, RLS forçada nas oito
  tabelas de identidade/equipe verificadas, papel real sem DDL/TEMP e pool limpo
  após commit/rollback. Base de desenvolvimento sem dados de negócio; a linha
  singleton técnica de `group_notifier_connection` é esperada da migração 025.
- Redis PONG; mídia gravada/lida/removida somente no volume v2. Rede Docker
  interna inspecionada e conexão TCP externa bloqueada; nenhum envio de provedor.
- CI preparada para `dev`/`new`/PR, sintaxe com assets e PostgreSQL/Redis
  sintéticos. Execução no GitHub depende de commit/push autorizado.
- Revisão independente: segurança e operação; autoria do harness pela operação,
  revisão do harness pelo principal/segurança. Sem bloqueador alto pendente.
  Incorporados os pedidos de preflight do terceiro banco antes de qualquer
  migração e de restringir o validador ao hostname Redis exclusivo.

Erros do primeiro harness foram corrigidos: nome do preparador que o node:test
descobria como teste, arquivos de infraestrutura ausentes da imagem de validação,
espera de serviço one-shot e agregados citext no snapshot de funções. O ensaio
vazio completo foi repetido em cluster efêmero após a correção.

Evidências locais: `.tmp/m0/{baseline.tap,integrations-final.log,fresh-proof.log,build.log,prepare-final.log,runtime-build.log}`.
Não são material para publicar. Não houve seed, restore, importação de clientes,
mensagem externa, VPS, commit, push ou deploy. As integrações opt-in restantes,
browser/UI, recuperação/rollback e gates M1–M10 continuam nas suas etapas.
