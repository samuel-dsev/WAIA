# Relatório de continuidade — WAIA

Atualizado em 3 de setembro de 2026 após a implementação e validação da Fase 9 do `PLAN.md`, ainda aguardando aprovação para commit e push.

## Objetivo vigente

Evoluir o WAIA para que uma nova empresa possa ser criada, configurada, testada, publicada, ativada, operada e suspensa pelo painel, sem edição de `.env`, SQL ou código e sem reinício ou deploy por tenant.

O provisionamento de número, WABA e permissões no Meta Business permanece externo. O painel deve receber, validar e guardar os dados fornecidos pela Meta sem expor segredos.

## Estado Git e proteção da versão atual

- Desenvolvimento realizado no checkout principal `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`, conforme autorização do usuário.
- `origin/main` permanece no commit de produção preservado `00a0a09` e não recebeu a atualização de onboarding.
- O baseline `00a0a09` continua disponível no worktree isolado `C:\Users\Samuel\Documents\Projetos\WAIA-baseline-00a0a09`.
- `origin/dev` e o `HEAD` local permanecem em `cbb03c1`, commit remoto da Fase 8 (`v1.8.1`).
- A Fase 9 está no working tree, preparada na versão `1.8.2`, mas ainda não foi commitada nem enviada porque depende de confirmação explícita.
- Nenhuma tag, merge em `main`, implantação ou publicação externa foi executada.

## Fases concluídas

### Fase 0 — baseline e isolamento Git

- Baseline anterior ao contrato V2 congelado e preservado.
- Respostas de caracterização do Capitão Mor protegidas por testes.
- Gate: versão atual reproduzível sem incorporar o onboarding em `origin/main`.

### Fase 1 — contratos e compilador

- Criados `TenantRuntimeConfigV2`, catálogo de capacidades, validação tipada, compilador e adaptador legado.
- A configuração existente do Capitão Mor compila sem alterar as respostas caracterizadas.
- Commit: `492a16d` (`v1.2.0`).

### Fase 2 — rascunho e publicação versionada

- Implementadas persistência de rascunho, revisão otimista, revisões imutáveis, checksum e publicação transacional.
- O runtime carrega apenas a revisão publicada e conserva fallback para configuração legada.
- Gate: editar o rascunho não altera o runtime ativo.

### Fase 3 — onboarding e readiness

- Implementados serviço, políticas, rotas administrativas, checks corrigíveis, auditoria e ativação/publicação transacionais.
- Novos tenants nascem em rascunho e não aceitam mudança de status pelo CRUD genérico.
- Empresas já ativas não são suspensas automaticamente pelas novas regras.
- Gate: dependências ausentes geram bloqueadores estáveis associados à etapa e à ação corretiva.
- Commit remoto atual: `6ec0236` (`v1.4.0`).

### Fase 4 — fluxos configuráveis

- Adicionado domínio `flows` com ações canônicas `flows.start`, `flows.continue` e `flows.cancel`.
- O contrato suporta mensagem, escolha única, texto, nome, e-mail, telefone, data, consentimento, documento/imagem, serviço, horário, handoff, conclusão e condição simples.
- O validador rejeita grafos inválidos, ciclos proibidos, referências ausentes, JavaScript, SQL, expressões arbitrárias, templates não permitidos e acesso a segredos.
- O executor é declarativo e determinístico; escolhas interativas respeitam os limites do WhatsApp.
- A migração aditiva `018_configurable_flows.sql` cria fluxos, versões imutáveis, submissões e documentos com `empresa_id`, FKs compostas, índices tenant-first e `ENABLE/FORCE ROW LEVEL SECURITY`.
- A publicação da configuração materializa as versões de fluxo dentro da mesma transação da revisão publicada.
- Conversas permanecem pinadas à versão de fluxo e à revisão de configuração em que começaram, mesmo após nova publicação.
- O runtime do worker inicia, continua, cancela, conclui ou transfere fluxos, preserva estado e anexa metadados de documentos sem chamadas externas livres.
- A retenção usa a política da revisão publicada pinada, anonimiza submissões vencidas e remove arquivos privados associados.
- O roteador permite cancelar ou trocar de intenção com segurança, mantendo compatibilidade com tenants legados sem `flows`.
- Gate atingido: o teste sintético percorre início por alias, botões, continuação pinada após uma nova versão, cancelamento, reset e reinício sem lógica específica por empresa.
- Commit remoto: `6227959` (`v1.5.0`).

### Fase 5 — Meta multiaplicativo

- A migração aditiva `019_meta_multi_application.sql` cria aplicativos Meta tenant-scoped, referências ao cofre, identificador público opaco do webhook, revisão otimista, estado, health, último webhook válido e retenção de erro sanitizado.
- Números WhatsApp passam a ter vínculo explícito com aplicativo Meta e credencial de access token do mesmo tenant, protegidos por FK composta e revisão do vínculo.
- Todas as novas estruturas usam índices tenant-first e `ENABLE/FORCE ROW LEVEL SECURITY`; nenhum segredo é armazenado na configuração ou nas revisões.
- A API administrativa permite listar, criar e editar aplicativos, vincular números, rotacionar App Secret e executar preflight sem receber ou devolver valores secretos.
- O callback dinâmico `GET/POST /webhook/meta/:webhookPublicId` resolve a conexão por identificador aleatório, valida assinatura sobre os bytes brutos, confere WABA e `phone_number_id` e só depois ingere os eventos.
- A rotação aceita o App Secret anterior por uma janela curta e limitada; fora dela, a credencial anterior não é carregada.
- O preflight consulta app, WABA e número na Graph API por cliente injetável, persiste somente resultado sanitizado e controla o estado do aplicativo com revisão otimista.
- O envio resolve exclusivamente o access token vinculado ao número e ao aplicativo ativo; números ainda não migrados conservam o fallback legado tenant-scoped.
- O endpoint legado `/webhook` permanece disponível para o Capitão Mor.
- Gate atingido: duas conexões com assinaturas, números, WABAs e credenciais diferentes foram testadas sem cruzamento, inclusive em PostgreSQL real.

### Fase 6 — wizard do painel

- O painel possui um wizard de dez etapas com empresa, módulos, atendimento, menus e roteamento, operação, fluxos, IA, WhatsApp/Meta, equipe e revisão.
- O draft V2 é a fonte de verdade do wizard. Autosave e retomada usam `draftVersion` e `revision`; conflito HTTP 409 pausa novas gravações e exige recarga explícita, sem sobrescrever a revisão atual.
- Trocas de tenant, navegação e logout aguardam o flush do rascunho; mutações de coleções são revertidas localmente quando o backend rejeita o draft, evitando perda silenciosa ou duplicação na tentativa seguinte.
- O refresh periódico não recria o wizard nem fecha diálogos com alterações em andamento.
- Dependências de módulos, menus, ações, parâmetros, serviços, horários, fluxos, credenciais, aplicativos Meta e usuários são escolhidos por rótulos; referências internas são geradas ou selecionadas sem digitação de UUIDs ou action keys.
- O editor de fluxos usa somente etapas e condições allowlisted, com escolha visual dos destinos e campos coletados.
- Chaves de IA, App Secret, verify token e access token seguem diretamente para o cofre. O draft, o DOM persistente e as respostas administrativas recebem somente referências ou valores mascarados.
- A equipe pode criar usuários, vincular conta global por e-mail exato, editar permissões e remover vínculos; estados globais e do vínculo são tratados separadamente e o backend impede suspensão, remoção ou rebaixamento do último administrador ativo.
- A revisão apresenta checks do backend, validação, publicação e ativação com a versão confirmada. O simulador permanece explicitamente indisponível até a Fase 7 e não finge uma execução.
- Erros estruturados chegam aos campos do formulário e dos diálogos com foco e atributos acessíveis; o layout possui navegação por teclado, adaptação móvel e suporte a redução de movimento.
- O Nginx do painel encaminha somente `/api/`, `/webhook` e `/webhook/` à API, permitindo usar a origem pública do painel no callback Meta sem expor outras rotas internas.
- Gate atingido: a jornada da Fase 6 não exige IDs internos, SQL, `.env`, arquivo de tenant, alteração de código ou reinício por empresa.

### Fase 7 — simulador e preflight

- O simulador executa o draft corrente com o mesmo compilador V2, materializador e runtime configurável usados pelo worker.
- Conversa, contato, estado, pedidos, agendamentos, handoff, submissões e documentos do simulador ficam exclusivamente em memória e são isolados por administrador, tenant e sessão.
- Sessões usam revisão otimista, expiração, limite por administrador/tenant, limite global e invalidação quando o checksum do draft muda.
- Texto, botões, listas, aliases, fallback, documentos sintéticos, reset, agendamento, fluxos e handoff podem ser exercitados pelo painel.
- IA e integrações são simuladas; o serviço não recebe gateways, credenciais ou repositórios persistentes e informa explicitamente que chamadas externas são proibidas.
- O preflight resolve no backend o número principal e o aplicativo Meta, testa somente integrações allowlisted e propaga cancelamento por timeout à Meta, OpenAI e Google Sheets.
- Erros externos são convertidos em códigos públicos estáveis; tokens, respostas de provedores e detalhes internos não chegam à API, auditoria ou painel.
- Cada execução externa registra início e conclusão sanitizados sob o mesmo `preflightId`, com ator, tenant, correlação, códigos dos checks e resultado. A auditoria inicial precisa ser persistida antes de qualquer chamada externa; timeout aborta o probe e sinaliza integrações que não encerram cooperativamente.
- O runtime versionado de IA lê exclusivamente a revisão ativa, valida versão e checksum e recusa credenciais de outro tenant ou provedor antes de decifrá-las; o caminho legado continua restrito a empresas explicitamente legadas.
- O pagamento versionado resolve exatamente a credencial `payment` publicada no V2. Uma integração externa não substitui a credencial PIX exigida pelo runtime, e falhas de vínculo fecham a carga sem recorrer à tabela legada.
- O readiness continua sendo o único gate autoritativo para publicação e ativação e agora valida também o provedor associado a cada referência de credencial.
- As novas rotas administrativas são tenant-scoped, exigem administrador da empresa, CSRF, versão exata do draft, corpo allowlisted e rate limit específico.
- A etapa de revisão do wizard agora executa preflight e abre um diálogo acessível do simulador, sem persistir histórico no navegador.
- Gate atingido no escopo conversacional: simulador e runtime tomam as mesmas decisões usando o mesmo contrato compilado e a mesma fábrica de runtime. Efeitos externos continuam deliberadamente simulados e serão cobertos pela regressão operacional das Fases 8 a 10.

### Fase 8 — regressão do Capitão Mor

- A jornada conversacional cobre saudação, menu, cardápio, endereço, regras públicas, agenda, paginação, seleção de sexta e sábado, compra, preço atual, PIX sintético mascarado, comprovante e pedido pendente.
- PIX e dados transacionais permanecem fora da IA; perguntas públicas usam somente o contexto permitido, e uma nova intenção interrompe com segurança a espera por comprovante.
- Handoff, pausa da automação e resposta humana sobrevivem à reinstanciação dos serviços sem duplicar mensagens.
- Outbox e exportação Google Sheets preservam referências mínimas, retry após indisponibilidade do Redis, contrato legado `Pedidos!A:G` e idempotência após reinício.
- Status Meta evolui sem regressão, e mensagens, IDs Meta, IDs internos, filas, runtimes, IA e credenciais permanecem isolados por tenant mesmo quando os identificadores são repetidos.
- O seed canônico do Capitão Mor foi carregado no PostgreSQL do `waia-test` com dados exclusivamente sintéticos e reaplicado de forma idempotente.
- Gate atingido: nenhuma regressão funcional ou evidência de vazamento entre tenants foi encontrada na matriz da Fase 8.

### Fase 9 — segunda empresa sintética

- A jornada automatizada cria a Empresa Beta Sintética pelas mesmas rotas HTTP, autenticação, autorização e CSRF usadas pelo painel; nenhum tenant é criado por SQL, seed, arquivo ou alteração de `.env`.
- A Beta recebe administrador e operador, configuração V2 com módulos, menu, respostas públicas, agendamento, fluxo declarativo e IA simulada; o simulador usa o draft corrente sem rede ou credenciais reais.
- Meta é exercitada com aplicativo, número, vínculo e preflight completamente simulados e tenant-scoped, sem chamada ao Graph real nem uso de token real.
- Publicação e ativação materializam revisões e versões de fluxo; a suspensão posterior bloqueia somente a Beta e mantém o Capitão Mor ativo.
- Callbacks Meta simultâneos reutilizam IDs de mensagem, conversa, correlação e credencial entre Capitão Mor e Beta sem cruzar segredo, deduplicação, fila ou tenant.
- A recriação lógica do worker preserva revisões, conversas e estados duráveis distintos: o Capitão Mor continua aguardando comprovante enquanto a Beta continua o agendamento.
- A regressão da Beta revelou que uma resposta pública associada a uma ação canônica podia duplicar essa ação no registro do simulador. O runtime agora deduplica as chaves e mantém a resposta configurada como override.
- O fluxo completo foi validado no harness administrativo isolado; a Beta não foi persistida no PostgreSQL do `waia-test`, e a navegação visual não foi declarada como executada porque nenhuma superfície de navegador estava disponível nesta sessão.
- Gate atingido no escopo automatizado da Fase 9: cadastro completo pelas rotas do painel, operação simultânea, reinício lógico e suspensão sem operação manual de backend nem cruzamento entre tenants. A navegação visual e a matriz final persistente permanecem na Fase 10.

## Validação da Fase 5

- `npm test`: 334 testes descobertos, 324 aprovados, 0 falhas e 10 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: 197 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas.
- `docker compose -p waia-test config --quiet`: configuração válida com valores sintéticos.
- O padrão permanente para novas validações Docker é o projeto isolado `waia-test`; projetos existentes não serão removidos sem autorização explícita.
- PostgreSQL 16 real no `waia-test`: 19 migrações aplicadas; integração de dois aplicativos, números e credenciais Meta por tenant aprovada, incluindo bloqueio de vínculo cruzado.
- API e worker do `waia-test` ficaram saudáveis; `/health/ready` respondeu HTTP 200 com estado `ready`.

## Validação da Fase 6

- `npm test`: 357 testes descobertos, 347 aprovados, 0 falhas e 10 integrações opcionais ignoradas sem variáveis de infraestrutura.
- Testes focados do painel e do suporte administrativo: 48 aprovados e 0 falhas.
- `node --check`: 200 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas.
- `docker compose -p waia-test config --quiet`: configuração válida; nenhum projeto Docker existente foi removido e nenhum projeto permanente por fase foi criado.
- PostgreSQL 16 real no `waia-test`: 9 integrações aprovadas, cobrindo onboarding/ativação transacional, publicação versionada, fluxos, Meta multiaplicativo, RLS, mídia, outbox e Google Sheets.
- Redis real no `waia-test`: integração aprovada, mantendo somente referências de resposta humana.
- Jornada HTTP real pelo painel: login, criação de empresa sintética em `draft`, salvamento do draft V2, retomada na etapa 2, readiness bloqueada e conflito stale HTTP 409 sem overwrite.
- Build final reconstruído no projeto existente `waia-test`; API, worker, PostgreSQL e Redis ficaram saudáveis, enquanto `db-init` e migrador concluíram com código zero.
- Nginx validado com `nginx -t`; os assets finais `app.js` e `onboarding.js` responderam HTTP 200, o callback dinâmico foi encaminhado à API e `/health/live` e `/health/ready` responderam HTTP 200.
- A navegação visual autenticada pelo navegador embutido não foi executada porque esse navegador não alcançou a rede local do Docker; a navegação real permanece também na matriz final da Fase 10.

## Validação da Fase 7

- Testes focados de simulador, preflight, API, serviço, repositório, painel, IA e pagamento passaram sem falhas; o maior lote integrado teve 76 testes e a revisão final de credenciais teve 24.
- `npm test`: 389 testes descobertos, 379 aprovados, 0 falhas e 10 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: os 31 arquivos JavaScript alterados nesta entrega possuem sintaxe válida.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas.
- PostgreSQL e Redis reais no `waia-test`: 10 integrações aprovadas em grupos serializados, cobrindo onboarding, configuração versionada, fluxos, Meta multiaplicativo, RLS, mídia, outbox, Google Sheets e Redis.
- A execução simultânea de toda a suíte dentro do mesmo banco sintético apresentou uma colisão entre fixtures concorrentes; a repetição em grupos isolados comprovou que não havia falha funcional.
- `docker compose -p waia-test config --quiet`: configuração válida com valores exclusivamente sintéticos.
- API, worker e migrador foram reconstruídos novamente após a revisão final de credenciais, na versão `1.8.0`; 19 migrações foram descobertas, nenhuma nova era necessária nesta fase, e API, worker, PostgreSQL e Redis ficaram saudáveis.
- `/health/live` e `/health/ready` responderam HTTP 200. A rota administrativa de preflight respondeu HTTP 401 sem sessão, confirmando que o proxy do painel preserva a autenticação.
- Após a recriação da API, o Nginx do painel precisou ser reiniciado para renovar o endereço do upstream; depois disso, o proxy voltou a responder normalmente. Nenhuma alteração de configuração ou novo projeto permanente foi necessária.
- O painel e seus assets responderam HTTP 200 no `localhost` publicado temporariamente. O navegador embutido permaneceu sem acesso à rede local do Docker; o contêiner temporário foi encerrado e os projetos existentes foram preservados.

## Validação da Fase 8

- Os três lotes especializados de regressão somam 10 testes aprovados: 5 de conversa e compra, 3 de isolamento multiempresa e 2 de operação, reinício e idempotência.
- `npm test`: 400 testes descobertos, 389 aprovados, 0 falhas e 11 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: os quatro arquivos JavaScript adicionados nesta fase possuem sintaxe válida.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas e com distribuição por tenant preservada.
- O seed foi executado novamente no projeto `waia-test` e retornou `0 novo(s), 2 descoberto(s)`, comprovando reaplicação idempotente sem criar outro projeto Docker.
- PostgreSQL 16 real no `waia-test`: 10 integrações aprovadas, incluindo a carga do Capitão Mor pelo papel restrito da aplicação, publicação versionada, onboarding, flows, Meta multiaplicativo, RLS, mídia, outbox e Google Sheets.
- Redis real no `waia-test`: integração aprovada, mantendo somente referências da resposta humana.
- `docker compose -p waia-test config --quiet`: configuração válida com valores exclusivamente sintéticos; nenhum projeto permanente por fase foi criado ou removido.
- API e worker foram reconstruídos na versão `1.8.1` e ficaram saudáveis; `db-init`, `media-init` e migrador concluíram com código zero, com 19 migrações descobertas e nenhuma nova nesta fase.
- `/health/live` e `/health/ready` responderam HTTP 200 com estados `ok` e `ready`.

## Validação da Fase 9

- Testes focados da Fase 9: 3 aprovados e 0 falhas, cobrindo jornada administrativa completa, callbacks repetidos e isolamento após recriação do worker.
- `npm test`: 403 testes descobertos, 392 aprovados, 0 falhas e 11 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: o runtime corrigido e os dois novos arquivos de teste possuem sintaxe válida.
- `npm run load:test`: cinco cenários sintéticos aprovados, entre 250 e 800 jobs, sem falhas e com distribuição por tenant preservada.
- PostgreSQL 16 real no `waia-test`: 10 integrações aprovadas em grupos serializados, incluindo publicação versionada, onboarding transacional, flows, Meta multiaplicativo, RLS, agendamento, mídia, resposta humana, Google Sheets e regressão do Capitão Mor.
- Redis real no `waia-test`: integração aprovada, mantendo somente referências da resposta humana.
- `docker compose -p waia-test config --quiet`: configuração válida; o conjunto de credenciais sintéticas já associado ao volume precisou ser preservado para não divergir do `.env` local.
- O primeiro build padrão com a correção concluiu normalmente. Após apenas a mudança de versão invalidar a camada de dependências, o registry deixou o `npm ci` sem progresso; o build final `1.8.2` reutilizou o `node_modules` da imagem já validada, pois nenhuma dependência mudou, e substituiu somente os arquivos do checkout.
- API e worker foram recriados na versão `1.8.2`; `db-init` e migrador concluíram com código zero, PostgreSQL e Redis permaneceram saudáveis e o Nginx do painel teve o upstream renovado.
- API e worker não contêm `POSTGRES_PASSWORD` nem `DATABASE_MIGRATOR_URL`; `/health/live` e `/health/ready` responderam HTTP 200 com estados `ok` e `ready`.
- Um proxy local e um administrador exclusivamente sintéticos foram criados para tentar a navegação visual; como não havia navegador disponível, ambos foram removidos ao final sem alterar os demais dados ou projetos Docker.

## Segurança e limites preservados

- Nenhuma credencial real foi lida, registrada ou usada.
- Nenhum dado da Filaretti foi criado.
- Configurações e revisões não armazenam segredos; apenas referências ao cofre são permitidas.
- Fluxos não executam JavaScript, SQL, HTTP livre nem templates arbitrários.
- O endpoint legado `/webhook` continua necessário temporariamente para o Capitão Mor.
- O ambiente `waia-test` recebeu somente dados sintéticos de validação, incluindo o seed canônico do Capitão Mor; a Empresa Beta Sintética planejada para a Fase 9 não foi criada.

## Próxima fase planejada — Fase 10

A Fase 10 — validação final só poderá começar após o commit e push confirmados da Fase 9 e uma nova autorização explícita do usuário.

Escopo previsto:

- suíte integral e build reproduzível;
- PostgreSQL, Redis, Docker Compose, RLS, auditoria e inspeção de segredos;
- carga e health/readiness;
- jornada persistente e navegação visual real do painel;
- consolidação final da documentação e do relatório.

O teste de carga atual é uma regressão em memória; não mede capacidade de VPS, latência de rede nem limites de provedores externos.

## Pendências operacionais

- A navegação visual autenticada ainda depende de uma superfície de navegador capaz de alcançar o painel local.
- O `.env` local não deve ser usado para recriar o PostgreSQL persistente do `waia-test` sem antes alinhar as credenciais sintéticas já associadas ao volume.
