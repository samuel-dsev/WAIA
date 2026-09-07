# Relatório de continuidade — WAIA

Atualizado em 6 de setembro de 2026 após a publicação controlada da candidata na Hostinger. A infraestrutura WAIA está saudável e acessível por HTTPS, mas continua sem empresas ou credenciais externas reais.

## Objetivo vigente

Evoluir o WAIA para que uma nova empresa possa ser criada, configurada, testada, publicada, ativada, operada e suspensa pelo painel, sem edição de `.env`, SQL ou código e sem reinício ou deploy por tenant.

O provisionamento de número, WABA e permissões no Meta Business permanece externo. O painel deve receber, validar e guardar os dados fornecidos pela Meta sem expor segredos.

## Estado Git e proteção da versão atual

- Desenvolvimento realizado no checkout principal `C:\Users\Samuel\Documents\Projetos\WAIA`, branch `dev`, conforme autorização do usuário.
- `origin/main` permanece no commit de produção preservado `00a0a09` e não recebeu a atualização de onboarding.
- O baseline `00a0a09` continua disponível no worktree isolado `C:\Users\Samuel\Documents\Projetos\WAIA-baseline-00a0a09`.
- `HEAD` e a referência local `origin/dev` apontam para `baf4a8f`, fechamento da Fase 12 (`v1.9.1`), conforme inspeção local nesta retomada; não houve fetch para confirmar o remoto ao vivo.
- A tag local anotada `v1.9.1-rc.1` resolve para `baf4a8f`. A presença da tag no remoto e a disponibilidade do artefato da CI ainda precisam ser verificadas.
- A branch local `main` aponta para `f07e6dc`; a referência local `origin/main` aponta para `00a0a09`. Não presumir que sejam iguais e não modificar nenhuma delas nesta preparação.
- Alterações locais anteriores em `AGENTS.md` e `RELATORIO.md` foram identificadas e preservadas.
- A candidata foi instalada na VPS e depois publicada de forma controlada em 6 de setembro. Não houve credenciais de provedores, empresas reais ou operação com clientes.

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

### Fase 10 — validação final concluída

- O runtime PostgreSQL aceita um cliente de health Meta injetado somente por chamada direta de código; sem injeção, continua instanciando o `MetaGraphHealthClient` real. Nenhuma variável de ambiente ou rota habilita simulação em produção.
- Uma integração opt-in inicia a aplicação real com PostgreSQL e Redis, autentica um administrador de plataforma, mantém cookie e CSRF e percorre as mesmas rotas HTTP consumidas pelo painel.
- A Empresa Beta Sintética foi persistida no `waia-test`, recebeu equipe, draft V2, simulação, número, credencial cifrada, aplicativo Meta compartilhado, vínculo, preflight simulado, publicação, ativação e suspensão sem SQL, seed, arquivo ou reinício por tenant.
- O cenário é retomável: uma Beta parcial pode continuar pela API, e uma Beta já concluída é revalidada sem duplicação. O estado prévio do Capitão Mor é comparado antes e depois e permanece inalterado.
- A navegação visual real foi concluída no navegador integrado: login, seleção da Empresa Beta Sintética, listagem de empresas, onboarding até a revisão final, número WhatsApp, módulos e configurações, auditoria, logs, uso de IA, diagnósticos e logout.
- A jornada visual revelou que os recursos append-only `logs`, `audit` e `ai-usage` tentavam selecionar `updated_at`, coluna inexistente nessas tabelas. Os descritores PostgreSQL agora consultam somente `created_at` e `occurred_at`, com teste de regressão dedicado; auditoria, logs e uso de IA foram revalidados no navegador sem erro.
- O build padrão inicialmente parou em `npm ci --omit=dev` pela rede do BuildKit. Após confirmar o registry por `npm ping`, o mesmo Dockerfile foi executado com rede de build `host`, instalou 104 pacotes pelo lockfile e gerou API e worker sem reutilizar `node_modules` de outra imagem.

### Fase 11 — bloqueadores técnicos implementados; gate externo pendente

- O Caddy encaminha somente a rota exata `/metrics`; o monitor operacional interno consulta readiness, métricas, heartbeat, filas e falhas e envia transições sanitizadas a um webhook HTTPS configurado. Alertas de quota da IA compartilham o mesmo destino.
- Backup e restore agora exigem projeto Compose explícito, alvo isolado e confirmação exata. O bundle contém dump PostgreSQL, mídia, manifesto, checksums e referência não secreta de custódia do keyring; o restore recompõe schema, dados, privilégios, migrações e mídia.
- A migration 020 torna a guarda recursiva de segredos compatível com `pg_restore` sob `search_path` restrito. O procedimento também recupera dumps anteriores à migration e limpa de forma determinística apenas o banco confirmado.
- As páginas de privacidade e exclusão foram generalizadas para a plataforma e exigem nome, contato e aviso de controladores aprovados; sem configuração respondem 503.
- A dependência transitiva `qs` foi atualizada pelo caminho suportado. O audit de produção ficou sem vulnerabilidades conhecidas.
- O painel ganhou troca autenticada de senha com verificação da senha atual, política forte, auditoria e revogação das demais sessões. Recuperação e MFA ficam formalmente mitigadas no piloto por credenciais individuais e allowlist IP/CIDR de todo o prefixo administrativo.
- OpenAI usa por padrão o snapshot `gpt-4.1-mini-2025-04-14`, catálogo de preços versionado e substituível por configuração, `X-Client-Request-Id` correlacionado e registro somente do request ID técnico devolvido pelo provedor.
- CI, build imutável por digest, promoção, rollback, custódia do keyring, restore e alertas foram documentados. O proxy temporário versionado em `.tmp/whatsapp-test` foi removido.
- Nenhuma alteração por tenant foi adicionada a `.env`, SQL, seed, código ou reinício; o Capitão Mor permaneceu funcional nas integrações reais.

### Fase 12 — homologação técnica limpa executada; release candidate pendente

- O Compose passou a aceitar `WAIA_IMAGE` em API, worker, migrador e monitor, permitindo promover o mesmo artefato com `--no-build`; o build local permanece apenas como fallback de desenvolvimento.
- O CI corrige a descoberta de JavaScript, constrói uma imagem identificada pelo commit e preserva a imagem exportada, seu checksum SHA-256 e os metadados do artefato como resultado do workflow.
- A imagem de produção copia somente `src`, `scripts`, `db`, `panel` e `public`; testes, relatórios, documentação e arquivos de ambiente não alteram mais o digest do runtime.
- A homologação `waia-phase12-homolog` nasceu em volumes vazios, com credenciais exclusivamente sintéticas e sem seed. `db-init` concluiu e 20 de 20 migrations foram aplicadas.
- O primeiro administrador foi criado pelo comando interativo, com senha apenas pelo stdin. Duas empresas sintéticas foram criadas pelas rotas autenticadas consumidas pelo painel, sem SQL, seed ou configuração manual por tenant; Alpha foi suspensa e Beta permaneceu em draft.
- API e worker foram reiniciados e retomaram com readiness 200, preservando os dois tenants e seus estados.
- Um backup completo da homologação foi restaurado no projeto descartável `waia-phase12-restore`; readiness, mídia e os estados acessados pelo painel foram recuperados.
- O fechamento Git da Fase 12 já consta no commit `baf4a8f` e na tag local `v1.9.1-rc.1`; a promoção remota do artefato permanece pendente de verificação.

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

## Validação da Fase 10

- `npm test`: 405 testes descobertos, 393 aprovados, 0 falhas e 12 integrações opcionais ignoradas sem variáveis de infraestrutura.
- `node --check`: 214 arquivos JavaScript válidos.
- Teste focado de bootstrap, Meta e E2E: 21 aprovados, 0 falhas e 1 integração opt-in ignorada no host.
- Testes focados do repositório administrativo PostgreSQL: 9 aprovados e 0 falhas, incluindo a regressão dos recursos append-only sem `updated_at`.
- E2E persistente no container temporário `--rm` do `waia-test`: 1 aprovado; uma segunda execução idempotente também foi aprovada.
- PostgreSQL 16 real: as 10 integrações anteriores passaram serialmente e o novo E2E persistente passou separadamente; 45 de 45 tabelas com `empresa_id` possuem `ENABLE/FORCE ROW LEVEL SECURITY`.
- Redis real: integração aprovada; varredura adicional examinou 12 chaves e 37 valores sem encontrar nenhuma credencial sintética conhecida.
- Drafts, revisões, auditoria e logs operacionais não contêm chaves sensíveis proibidas nem os valores sintéticos conhecidos; logs recentes da API e do worker também tiveram zero ocorrências.
- A Beta persistida terminou `suspensa`, em runtime `versionado`, com revisão ativa 3, duas revisões imutáveis, uma auditoria de ativação e uma de suspensão; o segredo Meta sintético não aparece nas revisões.
- O seed canônico do Capitão Mor permaneceu no mesmo estado anterior ao E2E, sua regressão PostgreSQL passou, a Filaretti continua ausente e `origin/main` permanece em `00a0a09`.
- `npm run load:test`: cinco cenários entre 250 e 800 jobs aprovados, sem falhas e com distribuição por tenant preservada.
- `docker compose -p waia-test config --quiet`: configuração válida com credenciais sintéticas compatíveis com o volume existente.
- API e worker foram reconstruídos e recriados em `1.8.3`; ambos ficaram saudáveis, usam `waia_app` e não recebem `POSTGRES_PASSWORD` nem `DATABASE_MIGRATOR_URL`.
- `/health/live` e `/health/ready` responderam HTTP 200. O endpoint autenticado de métricas respondeu HTTP 200 sem UUID, label de alta cardinalidade ou credencial sintética.
- O Nginx do painel passou em `nginx -t`; `/`, `app.js` e `onboarding.js` responderam HTTP 200 na porta interna 8080, e `/api/admin/auth/session` respondeu HTTP 401 sem sessão, como esperado.
- O build padrão de API/worker passou com `docker build --network=host`: `npm ci --omit=dev` instalou 104 pacotes em 8 segundos. O audit do npm informou uma vulnerabilidade moderada já presente; as dependências não foram alteradas nesta fase.
- A navegação autenticada foi executada visualmente em uma aba integrada. A auditoria exibiu 22 registros da Beta; logs e uso de IA exibiram seus estados vazios sem erro; os diagnósticos mostraram PostgreSQL, Redis e worker saudáveis; o logout encerrou a sessão com segurança.
- A porta e a rede bridge usadas somente para a inspeção visual foram removidas ao final. O painel voltou a expor apenas as portas internas do Compose, a rede temporária `waia-test-browser-public` está ausente e os demais serviços e projetos Docker foram preservados.

## Validação da Fase 11

- `npm test`: 414 testes descobertos, 402 aprovados, 0 falhas e 12 integrações opt-in ignoradas no host; a imagem limpa repetiu a suíte sem falhas com `NODE_ENV=test`.
- PostgreSQL 16 e Redis reais no `waia-test`: 12 de 12 integrações aprovadas em execução serial, incluindo regressão do Capitão Mor, onboarding, fluxos, Meta multiaplicativo, RLS, mídia, outbox, Google Sheets, painel persistente e Redis.
- A integração real encontrou e corrigiu a divergência de tipo de `bindingRevision` entre o repositório administrativo e o módulo Meta; o valor `bigint` agora sai como `number` em ambos.
- `npm audit --omit=dev`: 0 vulnerabilidades. `docker compose -p waia-test config --quiet` e a validação nativa do Caddy passaram.
- `node --check`: 220 arquivos JavaScript válidos. Build final limpo e sem `node_modules` externo concluído a partir de `node:22-alpine`; `npm ci --omit=dev` instalou 104 pacotes e encontrou 0 vulnerabilidades. A imagem local `waia:1.9.0-phase11` foi identificada pelo manifest list `sha256:ee62e513b1a37a875451d8d0519c0f407de628efacd18952a17d645d1055ef44`.
- `/metrics`, `/privacy` e `/data-deletion` passaram via HTTPS e Caddy real em contêiner transitório sem portas publicadas. O Caddy persistente não foi iniciado porque as portas 80/443 já pertenciam a outro ambiente, que não foi alterado.
- O ensaio de desastre criou bundle com checksums, restaurou dump e mídia em projeto Compose descartável, reaplicou privilégios e migrations e confirmou readiness, marcador de mídia e descriptografia de credencial sintética pelo keyring recuperado.
- O primeiro restore revelou a função recursiva incompatível com o `search_path` do `pg_restore`; a migration 020 e o procedimento compatível com dumps históricos foram implementados e o ensaio completo foi repetido com sucesso.
- O projeto descartável, seus volumes e os dois bundles temporários foram removidos após a validação. O `waia-test` permaneceu; a migration 020 foi aplicada nele e API, worker, PostgreSQL e Redis continuaram saudáveis.
- Nenhuma credencial real, endpoint externo ou produção foi usado. Não houve commit, push, tag, merge ou deploy.

## Validação da Fase 12

- Branch `dev` partiu limpa de `8740fa5`, sincronizado com `origin/dev`; `origin/main` permaneceu em `00a0a09`.
- API, worker e migrador usaram o mesmo image ID `sha256:861616212b498b2cdd3e0bbcbebf988646895e830e8d67aabfd32e99324098ad` na homologação e no alvo de restore, sempre com `--no-build`.
- Instalação vazia: 20 migrations novas de 20 descobertas e `/health/ready` HTTP 200.
- Contrato HTTP do painel: login, CSRF, criação de Alpha e Beta, suspensão de Alpha e listagem isolada aprovados. A sessão não dispunha de navegador para repetir a navegação visual.
- Integrações independentes de seed: 10 aprovadas com PostgreSQL e Redis reais. As duas regressões específicas do Capitão Mor confirmaram a ausência esperada do seed e não são aplicáveis a esta homologação limpa; continuam aprovadas no `waia-test` preservado.
- Reinício: readiness recuperada e estados `Alpha=suspended` e `Beta=draft` preservados.
- Backup/restore: checksums, PostgreSQL, mídia, privilégios e 20 migrations aprovados; o administrador restaurado autenticou e encontrou os mesmos estados dos tenants.
- `npm test`: 415 testes descobertos, 403 aprovados, 0 falhas e 12 integrações opt-in ignoradas no host. `npm audit --omit=dev`: 0 vulnerabilidades.
- Caddy em loopback HTTPS: painel, readiness, métricas autenticadas e página de privacidade responderam HTTP 200 com a imagem candidata final.
- Os dois projetos Compose descartáveis, seus volumes e o bundle sintético de backup foram removidos após a validação; o projeto `waia-test` permaneceu preservado.
- A exportação da imagem pelo GitHub Actions só poderá ser comprovada após o commit e push autorizados; localmente, a promoção sem rebuild e a identidade da imagem foram comprovadas nos dois ambientes descartáveis.
- Nenhuma credencial real, seed, tráfego externo, produção, tag ou merge foi usado.

## Segurança e limites preservados

- Nenhuma credencial real foi lida, registrada ou usada.
- Nenhum dado da Filaretti foi criado.
- Configurações e revisões não armazenam segredos; apenas referências ao cofre são permitidas.
- Fluxos não executam JavaScript, SQL, HTTP livre nem templates arbitrários.
- O endpoint legado `/webhook` continua necessário temporariamente para o Capitão Mor.
- O ambiente `waia-test` contém somente dados sintéticos de validação, incluindo o seed canônico do Capitão Mor e a Empresa Beta Sintética persistida pela Fase 10.

## Fechamento da Fase 10

A Fase 10 foi iniciada após o commit e push da Fase 9 e a autorização explícita do usuário. A matriz técnica, a jornada persistente e a validação visual foram concluídas; a entrega foi revisada e autorizada para commit e push na branch `dev`.

Itens já fechados:

- suíte integral e build reproduzível;
- PostgreSQL, Redis, Docker Compose, RLS, auditoria e inspeção de segredos;
- carga e health/readiness;
- jornada persistente pelas rotas reais do painel;
- navegação visual autenticada, incluindo auditoria, diagnósticos e logout;
- consolidação da documentação e do relatório.

O teste de carga atual é uma regressão em memória; não mede capacidade de VPS, latência de rede nem limites de provedores externos.

## Pendências operacionais

- O `.env` local não deve ser usado para recriar o PostgreSQL persistente do `waia-test` sem antes alinhar as credenciais sintéticas já associadas ao volume.
- Em 7 de setembro, o usuário aprovou RPO de 24 horas e RTO de 4 horas e indicou Samuel Felipe (`samuelfelipeleao@gmail.com`) como responsável por incidentes. O perímetro administrativo por allowlist já está ativo e comprovado.
- Google Drive foi escolhido para a cópia externa e Discord para alertas. O Drive usa cliente OAuth próprio do projeto `waia-production`; a cópia cifrada, o `cryptcheck` e o timer recorrente estão comprovados. O endpoint Discord respondeu HTTP 204 ao teste direto; falta promover a versão 1.10.0 e comprovar as transições de disparo/recuperação pelo monitor.
- MFA, convite e recuperação automatizada continuam posteriores ao piloto; o piloto só pode prosseguir após a allowlist/VPN real ser configurada e comprovada.
- O gate integral da Fase 11 permanece aberto até esses itens humanos e externos serem aceitos formalmente. A solicitação de 5 de setembro autoriza a preparação assistida da Hostinger; não constitui aceite dos P0 nem autorização para clientes reais.
- A preparação da Fase 13 foi solicitada pelo usuário nesta retomada. VPS, perímetro administrativo, DNS/TLS, backup externo, custódia do keyring fora da VPS, artefato imutável e smoke tests foram comprovados. A conclusão do gate ainda depende de promover a versão 1.10.0 e comprovar os alertas reais pelo monitor.

## Retomada de 5 de setembro de 2026

- Lidos `AGENTS.md`, `PLAN.md`, `implementações_finais.md`, relatório e runbooks de operação e integrações; inspecionados Compose, Caddy e workflow da CI.
- O Compose já mantém PostgreSQL/Redis sem portas públicas, possui volumes persistentes, rotação de logs e monitor opcional. Isso é configuração local, não evidência de infraestrutura implantada.
- Hostinger aberta no navegador visível. A página solicitou código de verificação por e-mail; o usuário deve concluí-lo diretamente no site. Nenhum código ou senha foi solicitado no chat.
- O acesso inicial ao Docker local foi negado pelo sandbox. A consulta posterior com escalonamento autorizado encontrou a imagem homologada `waia:1.9.1-phase12-local`, que foi exportada sem rebuild. Nenhuma suíte integral ou integração foi reexecutada; resultados das fases anteriores acima são históricos.
- Correções documentais desta retomada usam versão `1.9.2`; o alvo de implantação continua sendo a candidata `v1.9.1-rc.1`, sem reconstrução implícita.
- Login concluído pelo usuário. VPS inspecionada: Ubuntu 24.04, Docker 29.3.0, Compose 5.1.0, 1 CPU/4 GB/50 GB, aproximadamente 37 GB livres e 2,5 GiB de memória disponível na leitura. EasyPanel/Traefik e dois n8n ativos foram preservados. Não houve reinício nem alteração de firewall.
- Portas 80/443 já ocupadas pelo Traefik; porta 3000 do EasyPanel publicada, SSH root/senha habilitado, UFW inativo e política INPUT ACCEPT. O sistema informa atualizações e reinício pendentes. NTP está sincronizado; não há swap.
- `waia.ia.br` não resolveu no DNS. Após a pergunta do usuário sobre endereço gratuito, a preparação passou a usar `srv1513113.hstgr.cloud`; os registros A/AAAA foram confirmados. O hostname foi posteriormente publicado com TLS válido, conforme a seção abaixo.
- Adicionado overlay privado `infra/hostinger/compose.staging.yml`, com portas em loopback, limites de recursos e sem build/Caddy público. A validação com dados sintéticos no nome Compose `waia-test` comprovou essas invariantes, sem iniciar ou modificar contêineres.
- Exportados localmente a imagem homologada e os arquivos de infraestrutura/painel da tag candidata; arquivos temporários desta preparação ficam ignorados no Git. O navegador sem sessão GitHub não permitiu conferir o artefato da CI.
- O usuário instalou a chave temporária pelo Web console, com restrições de forwarding/PTY, expiração de duas horas e remoção agendada. As permissões da chave local foram ajustadas para a conta Samuel, permitindo a conexão SSH com identidade do servidor previamente conferida.
- Os checksums dos artefatos foram conferidos na VPS. A candidata mantém o image ID homologado, sem rebuild; a validação também comprovou reconstrução byte a byte do arquivo usando camadas oficiais compartilhadas durante o diagnóstico da transferência lenta.

## Instalação privada na Hostinger — 6 de setembro de 2026

- Diretório: `/opt/waia/releases/v1.9.1-rc.1`; projeto Compose `waia-prod`, separado dos serviços existentes. Artefato `baf4a8f`/`v1.9.1-rc.1`, image ID `sha256:861616212b498b2cdd3e0bbcbebf988646895e830e8d67aabfd32e99324098ad`.
- Segredos de infraestrutura novos foram gerados somente na VPS e armazenados no `.env` com permissão 600. Os campos Meta obrigatórios receberam valores aleatórios locais, sem aplicativo real conectado. Nenhum segredo foi impresso ou copiado para o relatório.
- API e painel vinculados somente a `127.0.0.1:13001` e `127.0.0.1:18080`; banco e Redis sem portas publicadas. Caddy não foi iniciado. EasyPanel, Traefik e ambos os n8n foram preservados.
- Corrigida a rede do painel: ele precisa também da rede egress para o Docker publicar a porta em loopback. Ajustada para 755 somente a pasta de assets públicos montada no Nginx; a extração segura com umask 077 havia deixado essa pasta inacessível ao worker.
- API, worker, PostgreSQL e Redis saudáveis; painel em execução. Foram aplicadas 20 migrações. Banco com zero empresas, zero usuários e 48 tabelas com RLS habilitada e forçada.
- Smoke tests: live/readiness, painel e asset HTTP 200; administração direta e via painel HTTP 403; métricas sem token HTTP 401; webhook sem assinatura HTTP 401; páginas legais HTTP 503 enquanto conteúdo aprovado permanece ausente.
- API e worker reiniciados, com repetição dos smoke tests aprovada e persistência preservada. Não houve reinício da VPS nem dos serviços anteriores.
- Backup local inicial em `/opt/waia/backups/waia-backup-20260906T170623Z`; dump, mídia e manifesto passaram nos checksums. O restore isolado foi posteriormente aprovado, conforme a seção abaixo. A cópia externa posterior ao deploy foi comprovada em um bundle mais recente; a custódia independente do keyring continua pendente.
- Evidências sanitizadas `private-smoke.json`, `release-evidence.json` e `infra-images.json` preservadas na release e copiadas para a pasta temporária local ignorada no Git. Digests das imagens auxiliares registrados; elas vieram do registry oficial, enquanto o runtime permaneceu exatamente na candidata.
- Versão local das correções de configuração/documentação: `1.9.2`; nenhuma alteração do runtime da candidata. Compose e invariantes de segurança validados; `git diff --check` aprovado. Não houve commit ou push.
- Pendência para concluir a Fase 13: promover a versão 1.10.0 e comprovar alertas reais de disparo e recuperação pelo monitor. RPO/RTO, responsável por incidentes, backup externo, custódia do keyring e os destinos Google Drive/Discord foram definidos e comprovados em 7 de setembro.
- A chave SSH temporária foi removida do servidor ao concluir a instalação privada, preservando as chaves anteriores. Uma nova tentativa autenticada foi rejeitada, comprovando a revogação. A chave privada temporária local também foi excluída.
- Na continuação de 6 de setembro, uma nova chave temporária foi autorizada e instalada com expiração de duas horas. A stack privada permanecia saudável havia quatro horas.
- Preparados e validados o ingresso pelo overlay `easypanel`, a rota Traefik para `srv1513113.hstgr.cloud` e a allowlist do IP administrativo atual. O desenho publica webhooks, health e páginas legais; restringe painel, `/api/admin` e `/metrics`, que também exige Bearer.
- A aplicação da rota foi recusada pela revisão automática por representar exposição externa persistente sem autorização específica para publicar os endpoints. A verificação posterior confirmou rota ausente, API não recriada e HTTPS ainda respondendo 404. Nenhuma publicação parcial ocorreu.

## Publicação HTTPS e restore drill — 6 de setembro de 2026

- Após autorização explícita do usuário, API e painel foram conectados à rede attachable `easypanel` e somente esses dois contêineres foram recriados. PostgreSQL, Redis, worker, EasyPanel, Traefik e os dois n8n permaneceram ativos.
- O Traefik passou a encaminhar `srv1513113.hstgr.cloud` com certificado Let's Encrypt válido e SAN correspondente. Health público retorna 200; as páginas legais retornam 503 até receberem conteúdo aprovado.
- Painel e `/api/admin` exigem allowlist do IPv4 administrativo atual. A sessão sem login retorna 401 a partir do IP autorizado; painel e administração retornam 403 fora dele.
- A rota exata `/metrics` foi corrigida após o primeiro teste revelar que o fallback do painel devolvia HTML 200. Agora ela segue para a API com allowlist e Bearer: 401 sem token no IP autorizado e 403 fora da allowlist.
- O callback para um identificador inexistente retornou 404 sem persistir dados. PostgreSQL, Redis e as portas de loopback 13001/18080 permaneceram inacessíveis externamente. As portas 22, 80, 443 e 3000 ainda respondem externamente; 22 e 3000 dependem do firewall definitivo.
- O bundle `/opt/waia/backups/waia-backup-20260906T170623Z` foi restaurado no projeto isolado `waia-restore-drill`, sem portas publicadas nem rota. Readiness, 20 migrações, zero tenants, 48 tabelas com RLS forçada e três entradas de mídia foram conferidos. Contêineres, redes e volumes descartáveis foram removidos; produção continuou com health 200.
- A Hostinger possui dois backups automáticos semanais separados da VPS, ambos anteriores à instalação observada. O plano oferece upgrade pago para backup diário. Nenhum upgrade foi contratado e nenhum snapshot manual foi substituído sem autorização.
- O painel publicado foi aberto no navegador e apresentou a tela de login. A VPS vence em 8 de setembro de 2026 e a renovação automática aparece ativa no hPanel; o alerta de renovação do plano de hospedagem deve ser tratado pelo titular.

## Hardening, snapshot, atualização e reboot — 6 de setembro de 2026

- Criado `waiaops` com chave Ed25519 dedicada, sudo sem senha e grupo Docker. A chave foi testada antes de qualquer alteração de rede. Sua parte privada permanece somente em `.secrets/hostinger-waiaops`, ignorada pelo Git.
- SSH efetivo: `PasswordAuthentication no`, `KbdInteractiveAuthentication no`, `PermitRootLogin without-password` e `PubkeyAuthentication yes`. A diretiva precisou ser instalada como `00-waia-hardening.conf`, pois `50-cloud-init.conf` definia senha como habilitada e o OpenSSH usa a primeira ocorrência aplicável.
- O firewall Hostinger `WAIA producao` foi criado e ativado com cinco regras: aceitar TCP 22 e 3000 somente do IPv4 administrativo; aceitar TCP 80 e 443 de qualquer origem; recusar todo o restante. O acesso por chave, painel, health e métricas foi retestado a partir do IP autorizado.
- Criado snapshot da VPS após a publicação, em 6 de setembro às 18:44, com expiração informada pela Hostinger em 7 de setembro. Os dois backups automáticos semanais anteriores continuam disponíveis. Nenhum upgrade pago foi contratado.
- Atualizados 45 pacotes do Ubuntu, incluindo Docker 29.8.0, Compose 5.5.1, containerd, AppArmor, Python e componentes de rede. O provider mantém cloud-init e metapacotes de kernel em hold; esse bloqueio não foi removido. Após o reboot, `/var/run/reboot-required` não existe.
- O upgrade do Docker reiniciou os contêineres e preservou WAIA. No reboot, os dois n8n ficaram `0/1` porque sua política `on-failure` não recriava tarefas encerradas de forma limpa. Ambos foram reativados e a política foi ajustada para `any`; ao final, EasyPanel, Traefik e os dois n8n estavam `1/1`.
- Verificação pós-reboot: cinco contêineres WAIA saudáveis, 20 migrações, zero tenants, zero usuários, 48 tabelas com RLS forçada, health público 200, painel/métricas 403 fora da allowlist e painel 200/métricas 401 sem Bearer a partir do IP autorizado.
- Instalado backup diário local via `waia-backup.timer`, às 03:15 UTC com atraso aleatório de até 15 minutos e retenção de sete dias. A execução inicial criou `waia-backup-20260906T215620Z`. O primeiro disparo realmente automático ocorreu em 7 de setembro às 03:17:36 UTC, criou `waia-backup-20260907T031736Z` e terminou com `Result=success`/`ExecMainStatus=0`; dump, mídia e manifesto passaram nos checksums. A referência permanece `server-env-only-external-custody-pending`, portanto cópia cifrada externa e custódia independente continuam abertas.
- A segunda chave temporária de root foi removida por comentário exato, sua cópia pública foi apagada da pasta de entrada e a chave privada temporária local foi excluída. Root ficou sem chaves autorizadas; `waiaops` é o acesso SSH operacional.

## Administrador inicial — 7 de setembro de 2026

- A primeira tentativa de cadastro por `docker compose run` avaliou as dependências após a atualização para Compose 5.5.1 e recriou PostgreSQL e Redis. O comando foi interrompido antes de receber dados administrativos. Os volumes persistentes foram preservados; a verificação imediata confirmou cinco serviços ativos, readiness HTTP 200, 20 migrações, zero empresas, zero usuários e 48 tabelas com RLS forçada.
- O cadastro foi repetido diretamente no contêiner ativo com `docker exec`, por sessão SSH interativa do usuário `waiaops`. O primeiro administrador foi criado sem passar a senha por argumento, arquivo ou chat.
- A verificação posterior confirmou exatamente um usuário, zero empresas, 20 migrações, 48 tabelas com RLS forçada, cinco contêineres ativos e readiness HTTP 200. O primeiro login carregou a visão global da plataforma com o papel de administrador. O logout emitido pelo painel com o CSRF da sessão foi processado e registrado como `auth.logout`/`sucesso`, confirmando autenticação e CSRF reais sem criar ou alterar tenants.

## Aceites e destinos externos — 7 de setembro de 2026

- O usuário aprovou RPO de 24 horas e RTO de 4 horas e indicou Samuel Felipe (`samuelfelipeleao@gmail.com`) como responsável por incidentes.
- Google Drive foi definido como destino da cópia externa. O rclone 1.75.1 foi obtido de fonte oficial, teve checksum conferido e foi instalado na VPS. A autorização OAuth foi concluída no navegador; o token ficou somente em arquivos ignorados pelo Git e a configuração foi instalada no servidor com modo 600. Uma consulta somente de leitura à API identificou a conta autorizada como `samuelfelipeleao@gmail.com`.
- A configuração preparada usa um remote `crypt` dedicado sobre a pasta `WAIA Backups`, com criptografia de conteúdo, nomes de arquivos e nomes de diretórios. A rotina rejeita remote sem `type = crypt`, valida os checksums locais antes do envio e executa `rclone cryptcheck --one-way` após a cópia.
- A autenticação atual usa temporariamente o cliente OAuth compartilhado do rclone. O rclone 1.75.1 avisou que esse cliente será retirado durante 2026 e recomendou um `client_id` próprio. O timer externo foi desabilitado antes do primeiro disparo; nenhum bundle foi enviado enquanto a conta específica e essa mitigação não forem confirmadas.
- Discord foi definido como canal de alertas. O runtime local passou a suportar o payload exigido pelo webhook Discord, limita a mensagem a 2.000 caracteres, desativa menções e mantém a sanitização de dados. A URL fornecida em arquivo local ignorado pelo Git passou na validação estrutural e respondeu HTTP 204 a uma mensagem técnica sem dados de clientes. A instalação na VPS e as transições reais dependem da promoção da versão 1.10.0.
- O usuário informou `Samuel Felipe Leão de Barros, pessoa física` como operador e forneceu o contato acima. Em seguida, declarou que assume a revisão jurídica e aprovou expressamente o texto integral e o aviso de controlador registrados em `docs/ACEITES_FASE_11.md`. A página de privacidade passou a registrar a aprovação em 7 de setembro de 2026.
- Os três valores legais foram aplicados ao `.env` da produção e somente a API foi recriada. `/privacy` e `/data-deletion` passaram de 503 para 200 e foram conferidas pelo contato e nome aprovados.
- Na primeira tentativa de aplicação, o usuário SSH não conseguiu entrar no diretório 700 da release; como o comando não falhou imediatamente, o Compose foi executado a partir do diretório pessoal sem carregar o `.env` de produção e a API respondeu 502. A correção foi aplicada em seguida por script `set -eu` executado como root dentro de `/opt/waia/current`, reutilizando o `.env` original. Ao final, API saudável, readiness privado/público 200 e os cinco contêineres WAIA ativos; banco, Redis, worker, painel e volumes não foram recriados.
- O primeiro envio externo autorizado terminou com `Result=success` e `ExecMainStatus=0` para `waia-backup-20260907T031736Z`. O script validou checksums antes do envio e o `rclone cryptcheck --one-way` confirmou o conteúdo cifrado no remote `waia-drive-crypt:production`.
- A criação do cliente OAuth próprio foi bloqueada pelo Google Cloud porque a conta ainda não possui verificação em duas etapas. Essa ativação de segurança exige ação manual do titular; até a troca, o cliente compartilhado permanece uma mitigação temporária sujeita à retirada anunciada pelo rclone.
- O titular ativou a verificação em duas etapas. Após a primeira consulta ainda indicar propagação, a consulta seguinte liberou o Console; o projeto existente `Chatbot Capitao Mor` foi preservado e a página de criação de um projeto separado para o WAIA foi aberta. O timer externo permanece desabilitado porque a revisão automática recusou o uso recorrente do OAuth compartilhado sem um aceite separado desse fallback.
- O usuário criou `WAIA Production` (`waia-production`) na conta correta `samuelfelipeleao@gmail.com` e informou que a conta `capitaomor4@gmail.com` foi removida. No projeto novo, a Google Drive API foi ativada e a Google Auth Platform configurada com app externo `WAIA Backup`, suporte e contato em `samuelfelipeleao@gmail.com`. O formulário do cliente desktop `WAIA Backup rclone` ficou completo, aguardando somente a confirmação imediatamente anterior à geração do ID e do segredo OAuth.
- Após confirmação explícita, os dois clientes OAuth cujos segredos apareceram em saídas de diagnóstico foram revogados. Um terceiro cliente desktop foi criado; ID e segredo foram capturados separadamente em arquivos ignorados pelo Git, sem exibição dos valores, e combinados em material local de recuperação. A conta `samuelfelipeleao@gmail.com` foi adicionada como único usuário de teste.
- O fluxo OAuth do cliente próprio foi concluído. A primeira troca do código falhou por bloqueio de rede do sandbox local e não gerou token; a repetição com rede autorizada terminou com token e refresh token válidos. Os logs temporários de autorização foram removidos após atualizar a configuração.
- O cliente próprio acessou `WAIA Backups` e leu `waia-drive-crypt:production/waia-backup-20260907T031736Z`. A configuração foi instalada atomicamente em `/etc/waia/rclone.conf`; novo disparo de `waia-backup-offsite.service` terminou com `Result=success`/`ExecMainStatus=0`, incluindo `cryptcheck --one-way`. O timer externo foi habilitado e ficou ativo, com próximo disparo observado para 8 de setembro às 03:50:06 UTC, dentro da janela de 03:45 UTC mais atraso aleatório.
- O `MASTER_KEYRING` foi copiado da VPS para a pasta local `.secrets`, normalizado sem alterar o valor lógico e validado com uma versão ativa recuperável. Keyring, chave SSH, configuração rclone, cliente OAuth e webhook receberam ACL restrita ao usuário Samuel e inventário local com tamanho e SHA-256. Esses arquivos permanecem ignorados pelo Git e constituem a cópia de custódia fora da VPS.
- O commit `d382245` (`v1.10.0 - conclui infraestrutura e alertas da Fase 13`) foi enviado para `origin/dev`. Na primeira tentativa de promoção, a imagem nova foi construída e o teste sintético enviou ao Discord as transições `queue_backlog_high` e `recovered`, mas a migração falhou antes da troca do runtime porque o checksum histórico era sensível a CRLF/LF. O rollback não precisou recriar serviços: o symlink e os cinco contêineres permaneceram na candidata `v1.9.1-rc.1`, todos saudáveis, com readiness público aprovado.
- A imagem anterior e o banco registravam o mesmo hash CRLF de `001_identity_and_configuration.sql`; o arquivo extraído do commit na VPS tinha conteúdo lógico idêntico em LF e outro hash. A versão 1.10.1 normaliza quebras de linha para LF nos novos registros e aceita, na validação de histórico, somente os hashes equivalentes LF/CRLF do mesmo SQL. Alterações reais continuam bloqueadas.
