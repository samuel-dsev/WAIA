# M1 — identidade e autorização

23/10/2026, America/Sao_Paulo. Branch `new`; M0 commitada **somente localmente**
em `89d46af` (`v1.23.3 - prepara baseline e ambiente isolado M0`). O usuário
autorizou continuar a M1, sem push. Candidata da M1: **1.24.0**; 2.0.0 continua
futura. M1 preparada para revisão, sem novo commit, promoção ou deploy.

Em 24/10/2026, o usuário autorizou o commit local da M1 e a M2 e padronizou
commit local ao final de cada fase validada. Preferência registrada em AGENTS,
sem autorização automática de push, deploy ou fase seguinte.

Commit local concluído em **88f7b21 / 1.24.0**. Continuidade da M2 autorizada
e resultados registrados em [M2_ACESSOS.md](M2_ACESSOS.md).

Snapshot selecionado para esse commit: 49 arquivos, sem portal/equipe e registros
operacionais alheios. Revalidado em Node 22: 600 pass/22 skips/zero falhas e 28
integrações reais aprovadas. Evidências em `.tmp/m0/m1-commit-baseline.tap`,
`m1-commit-integrations.log` e `m1-commit-build.log`. Os serviços v2 estavam
parados ao retomar e foram iniciados isoladamente antes dessa revalidação;
containers e volumes anteriores permaneceram preservados.

## Contratos implementados

- Login, autenticação e emissão de sessão administrativa exigem administrador
  global ativo, audience admin e MFA. Cookie customer não autentica admin.
  O banco também impede inserir/reabrir sessão admin sem esses requisitos.
- Challenge vincula audience, finalidade, identidade e versão de segurança;
  conclusão revalida o papel sob lock. O corpo da requisição não escolhe
  audience. Payloads administrativos desconhecidos são recusados. MFA pessoal
  continua disponível; MFA administrativo é obrigatório e não pode ser desativado.
- TTL de sessão MFA respeita a configuração de sua audience. O painel reaproveita
  a tela local de challenge/matrícula/códigos de recuperação; não houve redesign.
- `invalidateIdentitySecurity` centraliza versão de segurança, revogação das
  sessões, consumo de challenges/tokens e cancelamento da outbox de tokens.
  Reset, troca própria e mudanças globais pelo CRUD administrativo usam a mesma
  operação, com auditoria na transação. Falha de auditoria reverte a mutação.
  Troca própria admin preserva só sua sessão atual, atualizando sua versão;
  reset/mudança administrativa revogam todas. MFA/recovery não são removidos
  automaticamente por reset. Alterar e-mail pelo caminho administrativo invalida
  a verificação anterior, sessões e tokens.
- Signup, criação de empresa, equipe, convites e ownership são negados no HTTP
  e nos serviços, inclusive chamadas diretas. Habilitar contas não reabre esses
  caminhos. Segurança pessoal, login e recuperação permanecem disponíveis.
- `usuarios_empresas.permissoes` é a fonte das capacidades customer. Catálogo:
  attendance.read/edit/simulate/publish e opcionais conversations.read/reply/pause,
  leads.read. Owner, papel da empresa, `*` e permissões técnicas não concedem
  capacidades implicitamente. Opcionais continuam negadas nesta M1.
- Lista de empresas usa vínculos ativos e DTO com id/nome/estado/capacidades,
  sem owner, papel ou permissões técnicas. Abrir uma empresa exige attendance.read.
  Simular/publicar/enviar/retomar exige empresa ativa; suspensão permite apenas
  read/edit autorizados. Identidade/vínculo suspenso nega o acesso.

Essas capacidades são a fundação; M1 não cria endpoints de edição/simulação ou
publicação de atendimento, previstos nas etapas seguintes.

## Banco e transações

Aditiva **027_customer_authorization_boundary.sql**, sem alterar 001–026:

- Contexto customer explícito e policies restritivas, com RLS forçada existente.
  Cliente não escreve empresas/vínculos nem lê recursos técnicos. Perfil muda
  somente nome; sessão customer só admite revogação, sem ampliar prazo,
  alterar audience/versão ou reativar sessão.
- `withCustomerTransaction` recebe identidade/sessão do servidor e revalida
  sessão, versão, estado, vínculo e capacidade. Queries fixas de autorização
  usam bootstrap privilegiado fechado, travando identidade antes de sessão e
  vínculo. Antes do callback, o contexto vira customer sem bypass. O callback
  nunca recebe a transação privilegiada. Contextos commit/rollback não ficam
  no pool.
- Contextos de runtime interno/worker e administração preservam o caminho
  existente; contexto customer não se infere de IDs enviados pelo browser.
  A role de aplicação não possui SUPERUSER/BYPASSRLS/DDL/TEMP. Como na base
  anterior, o contexto SQL é confiado ao servidor; RLS não torna uma role com
  SQL arbitrário imune à alteração deliberada de seus próprios settings.
- Guard de sessão admin exige papel global ativo, MFA e versão atual. A migração
  revoga sessões administrativas anteriores incompatíveis. Guard adicional
  impede bloquear/rebaixar o último administrador global ativo.
- Empresas novas usam cadastro administrativo existente, sem linha automática
  em company_owners. Os vínculos serão atribuídos pelo painel em M2; owner
  legado continua protegido e não concede poderes ao customer.

## Validação e ambiente

Somente infraestrutura v2 de [M0_AMBIENTE.md](M0_AMBIENTE.md), preservando os
containers/volumes antigos e sem VPS. Schema aplicado às três bases v2 dedicadas;
`waia_v2_app` permanece sem dados de negócio. Fixtures de repositório usam UUIDs
e endereços fictícios e são removidas; não equivalem ao cadastro pelo produto
previsto em M3. Redis é exclusivo; API, worker e notificadores permanecem desligados.

Comandos globais de preparação/validação continuam os da M0. O validador agora
aceita upgrade verificado de 26 para 27, sem limpar alvos. O ensaio histórico
começa com 001–022 + 024–026; migrações faltantes aplicam 023 **antes** da 027.
Não simular a ordem irreal de instalar a fronteira 027 antes de criar as tabelas
da 023. Snapshot dos schemas finais equivalentes:
`94a7875708946b2a8b6e7e6d011275f79078dc1154223c26f91b29c7a3720709`.

- Node 22.23.2: **622 testes, 600 aprovados, 22 skips opt-in, zero falhas**.
- PostgreSQL/Redis reais: **28 aprovados, zero skips/falhas**. Sessões/revogação
  são verificadas em PostgreSQL; rate limit/fila/reagendamento em Redis real.
  Cobertura: N:N/zero vínculo, redução/remoção/suspensão, contextos forjados e
  pool, negação HTTP/serviço/SQL, MFA/replay/concorrência/expiração, audiences,
  reset/reativação e rollback de auditoria. Sessão customer de administrador
  global continua restrita a seus vínculos.
- Sintaxe: **291 arquivos** em src/scripts/test/panel/portal, aprovada.
- Schema vazio 27 e upgrade histórico 25 → 023+027 aprovados em PostgreSQL
  efêmero sem restore. Ledger/checksums e reaplicação zero conferidos.
- Auditoria de dependências: **zero vulnerabilidades**; nenhuma dependência
  alterada em relação à M0. CI preparada para esses testes; não executada no GitHub.
- Build padrão `waia:v2-m1-runtime-local` aprovado, com identidade/schema/assets
  presentes e testes/segredos ausentes. Imagem do checkout completo:
  `sha256:950ed7eaa0600398e884f2e9d99e704e1d8b09cecf99f689803d52ee7088b37a`.
  Não é um artefato de produção promovido.
- Rede interna, mídia exclusiva e egress continuam verificados pelo validador.
  Nenhuma mensagem externa ou entrega de e-mail real foi exercitada.

Evidências locais em `.tmp/m0/m1-{baseline-final.tap,integration-final.log,fresh-proof.log,build.log,runtime-build.log}`.
Esses arquivos não entram no commit. Os primeiros ensaios detectaram fixtures
administrativas sem audience, expectativas 401 para payload desconhecido (403)
e ausência de sessão retornando undefined em vez de null; corrigidos antes
do resultado final. O teste de tenant forjado usa audience customer explícita.

Revisões independentes: identidade e ataques/autorização; implementação dos
testes PostgreSQL por terceiro subagente, executados/integrados pelo principal.
Resolvidos row locks incompatíveis com policy de UPDATE negada, ordem de locks,
contexto privilegiado no callback, e campos sensíveis em UPDATE customer.
Nenhum achado alto de acesso/perda de dados ficou pendente.

## Escopo de arquivos e continuidade

Incorporados para a M1: segurança pessoal/MFA/TOTP local necessária, wiring de
bootstrap, backend de contas/auth/admin, migração 027, CI/validador e testes.
TeamService legado preservado com barreira incondicional; não é funcionalidade
cliente habilitada. Arquivos de portal/equipe, convite no .env/Compose e registro
operacional anterior continuam preservados e não são aprovados por arrasto.

Grupos principais: `src/modules/auth/{auth-service,http,repositories,permissions,identity-security,identity-lifecycle,totp}.js`,
`src/modules/accounts/{account-service,account-repository,http,runtime,team-service}.js`,
`src/modules/admin/{authorization,postgres-admin-repository}.js`,
`src/infra/postgres/transaction.js`, bootstrap, painel MFA, schema, testes e
continuidade. Manifests 1.24.0. Mensagem candidata para revisão futura:
`v1.24.0 - restringe identidade e autorização do portal na M1`.

M2 depende de nova autorização: painel global de acessos/vínculos/ativação e
reautenticação das operações administrativas críticas. M3 retirará telas antigas
de signup/equipe do portal. Gate M1 foi verificado pelo backend/HTTP/banco;
navegador e jornada final pertencem aos gates posteriores. Não há streams ou
ações customer de atendimento expostos nesta M1; sua revogação será validada
quando forem liberados.

Débitos delimitados: o guard de último administrador cobre bloqueio/rebaixamento
e soft delete, não DELETE físico (sem rota de exclusão global nesta fase).
Duas mutações administrativas concorrentes em usuários diferentes da mesma
empresa podem sofrer deadlock e rollback seguro no caminho legado de
continuidade; serialização administrativa será revista na M2. Não é perda de
dados nem escalada. Nenhum desses limites autoriza SQL por cliente ou deploy.
