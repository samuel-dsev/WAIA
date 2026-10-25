# M8 — homologação e revisão independente

Concluída localmente em 25/10/2026, America/Sao_Paulo. Checkout principal `new`,
base **a2f0a56 / v1.30.0**, entrega **v1.30.1**, com commit local no fechamento
conforme AGENTS. Sem push, promoção, deploy ou avanço à M9. A entrega 2.0.0
permanece futura. As alterações preexistentes alheias continuam fora do escopo.

No início, o Docker Desktop exibia Engine
running, mas sua API não respondia em desktop-linux/default, apesar do WSL vivo.
Nenhuma fixture desta rodada tinha iniciado. Usuário autorizou reinício e depois
assumiu a operação manual; a tentativa CLI do agente foi cancelada. O ambiente
Filaretti compartilha o Docker e precisa ser preservado, assim como todos os
volumes existentes. Após o reinício manual, apenas os serviços v2 existentes
foram reativados e o preview recomposto; Filaretti voltou saudável. Nenhum volume
foi removido. Essa indisponibilidade não foi registrada como falha da aplicação.

## Ambiente e execução

- Produto: preview loopback `http://127.0.0.1:5035/portal/`, painel `/panel/`,
  dataset fictício cadastrado/reutilizado pelo painel, banco `waia_v2_app`.
- Regressões e carga técnicas: somente `waia_v2_upgrade`, com app/owner separados,
  role sem superuser/BYPASSRLS, Redis e mídia v2 dedicados, rede interna existente
  `waia-test_v2_internal`. Fixtures de repositório não substituem cadastro pelo
  produto nem comprovam fornecedores.
- Instalação limpa: PostgreSQL temporário em tmpfs, mesma rede interna e projeto
  waia-test, sem porta pública nem banco/volume persistente montado. Confere
  identificação antes de remover exclusivamente seu próprio container temporário.
- Conversas, fichas, mídia e ações humanas permanecem fechadas no portal, conforme
  escolha explícita da M7. Sem egress real, worker de atendimento, seed, importação,
  reset ou restore dos ambientes existentes.

## Matriz T01–T24

A matriz associa os cenários aos testes e jornadas executados. Os gates locais
aplicáveis foram aprovados; os itens externos/operacionais pertencentes à M9
permanecem explicitamente pendentes. Isso não constitui aceite da 2.0.0 em produção.

| ID | Evidência principal | Limite |
|---|---|---|
| T01 | `bootstrap-runtime`, `portal-navigation`, browser M3/M7 | Expiração/revogação também no PostgreSQL |
| T02 | Browser M3: zero/uma/duas empresas | Dataset fictício pelo painel |
| T03 | `access-admin-postgres`, browser M3 | Capacidade independente por vínculo |
| T04 | `customer-authorization`, `attendance-postgres`, `m7-overview-postgres` | IDs/URL/body/query não definem autorização |
| T05 | `identity-security`, `team-postgres`, browser M8 | Customer não recebe audience/admin por cookie/challenge/header |
| T06 | `accounts-postgres`, `customer-authorization`, `team-postgres` | Signup, empresa/equipe/ownership continuam negados |
| T07 | `attendance-postgres`, `attendance-features-postgres`, `m7-overview-postgres` | DTO sem técnica/segredos, mesmo com role legado |
| T08 | `attendance-contract`, `attendance-http`, `m7-personal-security-postgres`, browser M7 | Texto literal/XSS e mass assignment |
| T09 | `m6-worker-postgres`, `attendance-postgres`, `team-postgres` | Sem stream customer liberado; worker revalida envio |
| T10 | `portal-navigation`, browser M3/M7 | Requests retidos/cancelados e troca de identidade |
| T11 | `access-admin-postgres`, `team-postgres`, `m7-personal-security-postgres`, browser M3 | Ativação/reset entregues só ao transporte fake local |
| T12 | `accounts-redis`, `attendance-budget-redis`, testes HTTP/identidade | Redis real, origem/CSRF e limites distribuídos |
| T13 | `access-admin-postgres`, `attendance-postgres` | Corridas/idempotência/auditoria transacional |
| T14 | `attendance-postgres`, browser M7/M8 | Draft e preservação do publicado/técnico |
| T15 | `attendance-postgres`, browser M8 | Dois editores e conflito409 sem sobrescrita |
| T16 | `attendance-publication-postgres` | Técnico oculto/base não aprovada bloqueados |
| T17 | `attendance-publication-postgres`, carga M8 | Banco/runtime reais; preflight externo fake controlado |
| T18 | `attendance-postgres`, `attendance-publication-postgres`, `m7-overview-postgres`, `m6-worker-postgres` | Suspensão da empresa não equivale a revogar vínculo/identidade |
| T19 | `m6-runtime-context`, `handoff-cooldown`, `lead-intake`, integrações | Determinismo antes da IA; providers fake, sem envio real |
| T20 | `m7-overview-postgres`, `private-media`, `postgres-integration` | Opcionais customer fechados, sem exportação nova |
| T21 | `m0-schema-check`, integrações com role real | RLS/contexto transacional/pool sem bypass |
| T22 | `m8-schema-check` e `m0-schema-check` | Fresh/upgrade/023 reais; backup/restore/rollback operacional na M9 |
| T23 | Browser M3/M7/M8: desktop/390/360px, teclado/perfil | Verificação de nomes/foco não é auditoria completa; e-mail real na M9 |
| T24 | CI new por inspeção, build local, browser/segurança, carga M8 | Sem CI remota nem ingress público final; artefato/infra final na M9 |

## Resultados e limites

Snapshot selecionado: **20 arquivos**. Node22 **682 casos, 652 aprovados,
30 skips opt-in, zero falhas**. Rodada ampliada serializada: **23 arquivos,
132 casos PostgreSQL/Redis aprovados, zero skips/falhas**. A rodada selecionada
anterior também passou em 113 casos; não somar os conjuntos sobrepostos. Sintaxe
de **333 arquivos JavaScript**, Compose e build aprovados. Auditoria npm final
sem vulnerabilidades; a primeira tentativa falhou por DNS e foi repetida com
sucesso. CI `new` conferida por código, sem execução remota.

Instalação limpa em tmpfs: **30 migrações**; upgrade histórico sintético de
**25** para30 aplicando023/027/028/029/030, sem seed/importação. Ledger/checksums,
equivalência de schema, role restrita, RLS forçada e contexto do pool aprovados.
Reaplicação zero. Após carga e regressões, `m0-schema-check` confirmou novamente
**zero dados de negócio** em `waia_v2_empty`/`waia_v2_upgrade`; banco de produto
e volumes anteriores preservados. Mídia/Redis dedicados e egress bloqueado.

Carga oficial: **10 empresas/20 sessões, 5req/s por600s, 3.000 requisições**.
Foram 2.700 leituras autorizadas e300 negações esperadas de empresa alheia,
zero vazamentos/erros inesperados/5xx/perda de slots. **p50 100,04ms,
p95 136,35ms, máximo883,95ms**, taxa efetiva5,001req/s. Dois ciclos de publicação
geraram quatro revisões únicas e dois conflitos409 esperados; retries com a
mesma chave retornaram a mesma publicação. Readiness/SQL/HTTP/Redis reais,
preflight externo fake e nenhum gateway. Não é SLA nem mede latência de provider.
O ensaio curto de12s foi usado só para depurar a fixture, nunca como gate600s.

Browser M3 reutilizou pelo painel três empresas/cinco identidades e preservou
capacidades alteradas em fases posteriores. Confirmou zero/uma/duas empresas,
deep link, recuperação fake, MFA/recovery, troca com resposta retida, revogação,
suspensão e logout. Identidades já ativas não repetiram ativação visual nova;
tokens/ativação/expiração/uso único foram exercitados no PostgreSQL. Browser M7
confirmou perfil, XSS literal/mass assignment, sessões, troca de identidade,
resumo sincronizado após salvar e opcionais fechados. Suplemento M8 confirmou
**1366/390/360px**, teclado/foco/nomes de controles, duas abas com sucesso/409
sem perder texto local, no-store/CSP e negação administrativa. Capturas reais
inspecionadas; sem overflow ou pageerrors. Saudação/nome fictícios restaurados;
somente versões/auditoria sintéticas avançaram.

Não houve publicação bem-sucedida no browser sobre a base técnica incompleta do
preview. T17 é sustentado pelo banco/runtime/carga com preflight fake, sem alegar
entrega externa. A verificação de nomes/foco não equivale a auditoria completa
de acessibilidade. A negação de cookie customer no proxy local não prova a
allowlist do futuro ingress público.

Três fixtures foram excluídas explicitamente do runner ampliado:
`capitao-mor-phase8-postgres` e `fase10-beta-postgres-panel` dependem do seed e
contrato administrativos históricos; `group-notifier-postgres` exige flag
`RUN_GROUP_NOTIFIER_POSTGRES` e banco descartável próprio, não habilitados nesta
rodada. Não foi executado seed histórico para satisfazê-las. Regressões de
domínio/worker/grupos permanecem na suíte local, e os opcionais customer seguem
negados. Não afirmar que todos os30 skips foram convertidos em integração real.

Revisões independentes de segurança/operação e E2E aprovadas, com revisão das
fixtures por agente sem autoria. Achados corrigidos: owner de fixture sob RLS
sem contexto administrativo, guard de banco temporário, limpeza por IDs próprios,
FKs restritivas, cascata de registros imutáveis e diretório isolado de mídia.
O smoke de carga deixou uma fixture incompleta; ela foi removida por seu prefixo
sintético e IDs próprios, sem reset. O browser antigo tentava recriar vínculos
com capacidades divergentes e recebia409 corretamente; passou a reutilizar os
acessos pelo painel, aguardando a lista. Nenhuma proteção da aplicação foi
afrouxada e nenhum código em `src/` ou `portal/` foi alterado nesta fase.

Sem bloqueador crítico/alto conhecido no fechamento. **M9 ainda precisa** da
candidata/artefato final, ingress público/admin privado, e-mail real e ensaios
operacionais de backup/restore/rollback em alvo autorizado. M10 mantém seu aceite
próprio. Sem produção, fornecedores reais, novas capacidades ou próximos gates
aprovados por arrasto.

## Arquivos

- Quatro runners M8 em `scripts/`: schema, browser, regressões e carga.
- `scripts/m3-browser-check.mjs`: reutilização segura do dataset e diagnóstico.
- Nove testes PostgreSQL: contexto do owner e limpeza de fixtures próprias;
  pools da aplicação e asserções de RLS/privilégios preservados.
- Package/lock **1.30.1**, plano, índice, relatório e este manual.

## Comandos

Após conferir os alvos e concluir o build do snapshot selecionado:

```powershell
rtk proxy docker build --target validation -t waia:v2-test-local .tmp/m8/selected
rtk proxy docker run --rm --network none waia:v2-test-local npm test
rtk proxy docker run --rm --network none waia:v2-test-local node scripts/check-syntax.mjs
rtk proxy node scripts/m8-schema-check.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/validate-v2-environment.mjs --tests-only
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/m8-regression-check.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/m8-load-check.mjs
rtk proxy docker compose --project-name waia-test --env-file .secrets/v2-test.env --file infra/compose.v2-test.yml run --rm --no-deps v2-check node scripts/m0-schema-check.mjs
rtk proxy node scripts/m3-browser-check.mjs
rtk proxy node scripts/m7-browser-check.mjs
rtk proxy node scripts/m8-browser-check.mjs
```

Browsers aceitam o caminho absoluto de `playwright/index.mjs` como argumento e
usam Edge/dataset privado existente. Evidências ficam em `.tmp/m8/`, ignorada pelo
Git; não versionar senhas, cookies, inbox fake, dumps ou `.secrets/`.

Não executar schema/checagem de ausência de dados durante a carga ou fixtures.
Preview mantido em **http://127.0.0.1:5035/portal/** e painel `/panel/`, com e-mail
fake e sem worker de atendimento. Mensagem de commit:
`v1.30.1 - homologa matriz de isolamento e jornadas na M8`.
