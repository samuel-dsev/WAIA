# Relatório de continuidade — WAIA

Atualizado em 1º de setembro de 2026 após concluir o rascunho e a publicação versionada da Fase 2 do onboarding pelo painel.

## Diagnóstico executivo

A fundação SaaS multiempresa está funcional e tecnicamente consistente para desenvolvimento e homologação controlada. Ela ainda não deve ser considerada pronta para produção: faltam ligar algumas capacidades já implementadas, completar a operação humana, validar integrações externas reais e fechar rotinas de segurança e recuperação.

Os executáveis oficiais são `src/api.js` e `src/worker.js`. A entrada `src/server.js` permanece apenas para compatibilidade com a demonstração legada do Capitão Mor.

## Onboarding pelo painel — Fase 0 concluída

- `dev`, `main`, `origin/dev` e `origin/main` foram confirmadas no commit preservado `00a0a09`; a `main` não foi alterada.
- As mudanças locais anteriores em `.gitignore`, `AGENTS.md` e `package.json` foram preservadas e permanecem separadas dos arquivos desta atualização.
- A versão preservada foi instalada em `C:\Users\Samuel\Documents\Projetos\WAIA-baseline-00a0a09`, como worktree destacado no SHA exato, sem branch própria.
- A pilha `waia-baseline-00a0a09` usa redes e volumes exclusivos para PostgreSQL, Redis e mídia, sem Caddy e sem portas publicadas no host.
- Depois da validação, os containers do baseline foram parados sem remover containers, worktree ou volumes, permitindo reinício futuro sem contaminar a `dev`.
- No worktree preservado, `npm test` aprovou 196 de 202 testes, com seis integrações opcionais ignoradas; 140 arquivos JavaScript passaram em `node --check`; os cinco cenários de carga sintética terminaram sem falhas; e o Compose foi validado com valores sintéticos.
- PostgreSQL, Redis, API e worker reais ficaram saudáveis; `/health/ready` retornou HTTP 200; os cinco testes PostgreSQL opcionais passaram depois de receberem explicitamente as URLs sintéticas dos papéis owner e aplicação.
- O teste Redis opcional expôs uma expectativa desatualizada: o contrato já normalizava `orderId` como `null`. A expectativa foi alinhada na `dev` e passou contra o Redis isolado.
- Foi adicionado um teste golden exato e totalmente sintético para menu, agenda, compra, PIX demonstrativo, comprovante, estado conversacional e pedido pendente do Capitão Mor.
- Na `dev`, a linha de base atualizada aprovou 197 de 203 testes, com as mesmas seis integrações opcionais ignoradas, e 141 arquivos JavaScript passaram na verificação de sintaxe.
- Nenhuma migração, credencial real, dado da Filaretti, tag, push, publicação, deploy ou alteração de runtime foi criada nesta fase. A Fase 1 depende de confirmação explícita do usuário.

## Onboarding pelo painel — Fase 1 concluída

- Criado o domínio isolado `src/modules/configuration/`, sem conectar o V2 ao loader PostgreSQL, API, worker ou painel nesta fase.
- `TenantRuntimeConfigV2` possui schema fechado para identidade, retenção, módulos, menu, roteamento, respostas públicas, catálogo, eventos, serviços, pagamentos por referência, pedidos, handoff, IA pública, fluxos declarativos e integrações por referência.
- O catálogo V2 contém as oito capacidades atuais e reserva `flows` como nona capacidade, com 19 ações, dependências, contextos permitidos e parâmetros fechados; o runtime V1 permanece com exatamente oito módulos.
- O compilador recebe o tenant e as versões por envelope confiável, gera configuração destacada e profundamente imutável, IDs de transporte determinísticos e checksum SHA-256 vinculado ao tenant, versão do compilador, revisão e versão otimista.
- A serialização canônica normaliza Unicode e rejeita ciclos, accessors, propriedades perigosas ou extras, arrays esparsos ou excessivos, valores não JSON, profundidade e tamanho acima dos limites.
- Segredos inline e formatos conhecidos de chave são recusados com erros sanitizados. Pagamentos, IA, handoff e integrações aceitam somente referências opacas do tipo esperado; o compilador não acessa o cofre, banco, relógio ou rede.
- O adaptador V1 → V2 descarta o PIX e demais bindings privados. A ponte temporária V2 → V1 só materializa pagamento por binding efêmero fora do draft, revisão e checksum.
- O teste de caracterização compara o Capitão Mor atual e a ponte V2 durante menu, agenda, cardápio, compra completa, comprovante, nome e criação do pedido pendente, sem alterar nenhuma resposta ou efeito esperado.
- `flows` valida apenas o contrato declarativo e referências `flow:*`; o executor, persistência, pinagem e submissões continuam reservados para a Fase 4.
- `npm test` aprovou 203 de 209 testes, com seis integrações opcionais ignoradas; 148 arquivos JavaScript passaram em `node --check`; os cinco cenários de carga sintética terminaram sem falhas.
- As migrações `001` a `016` não foram alteradas. Não houve banco, Docker, rota, painel, credencial real, tag, push, publicação ou deploy nesta fase. A Fase 2 só foi iniciada após confirmação explícita do usuário.

## Onboarding pelo painel — Fase 2 concluída

- Como o checkout principal estava em `main` com `package.json` local divergente, a implementação foi isolada em `.data/worktrees/fase2-dev`, na branch `dev` e no commit de partida `492a16d`; a `main` permaneceu em `00a0a09` e a alteração local não foi sobrescrita, guardada ou misturada.
- A migração aditiva `017_versioned_tenant_configuration.sql` criou progresso do onboarding, rascunho com `draft_version` otimista e revisões publicadas append-only, sem alterar as migrações `001` a `016`.
- As três estruturas são tenant-scoped, possuem limites JSONB, índices tenant-first, `ENABLE/FORCE ROW LEVEL SECURITY` e policies com `USING/WITH CHECK`. A revisão liga envelope, tenant, versões e checksum por constraints no banco.
- Empresas anteriores à migração foram explicitamente marcadas como `legado`; novas empresas recebem o modo `versionado` e permanecem sem revisão ativa até a primeira publicação. A ponte ativa usa FK composta `(empresa_id, config_version)`.
- O seed sintético do Capitão Mor declara o modo `legado`, preservando o runtime atual tanto em bancos migrados quanto na sequência banco vazio → migrações → seeds.
- O serviço versionado salva drafts com precondição obrigatória (`0 → 1`, `N → N+1`), retorna conflito estruturado e sanitizado, e audita criação ou atualização sem armazenar conteúdo da configuração na auditoria.
- Drafts incompletos são aceitos para autosave, mas passam por uma allowlist recursiva do schema V2: campos desconhecidos, `transportId` administrativo, JSON inseguro e padrões de segredo são recusados antes da persistência e novamente na leitura.
- A publicação bloqueia empresa e draft, recompila dentro da transação, insere a revisão imutável, atualiza a ponte ativa, incrementa a versão e registra a auditoria na mesma unidade. Falha de compilação ou auditoria reverte todos os efeitos.
- O loader PostgreSQL usa somente revisão ativa com envelope e checksum válidos para tenants versionados. Ausência, corrupção, ponte inconsistente ou modo desconhecido falham fechado; somente o valor explícito `legado` consulta as tabelas anteriores.
- `npm test` aprovou 223 de 230 testes, com sete integrações opcionais ignoradas; 155 arquivos JavaScript passaram em `node --check`; e os cinco cenários de carga sintética terminaram sem falhas.
- Em uma pilha Docker isolada `waia-fase2`, as 17 migrações foram aplicadas. As seis integrações PostgreSQL reais passaram, cobrindo papel restrito, RLS, domínio anterior, concorrência otimista, rollback, checksum e bloqueio de `UPDATE`/`DELETE` das revisões.
- PostgreSQL, Redis, API e worker ficaram saudáveis e `/health/ready` retornou HTTP 200. O seed isolado confirmou `capitao-mor|legado|null`. Após a validação, os containers foram parados sem remover volumes.
- Não foram criadas rotas HTTP, wizard, readiness, ativação administrativa, flows executáveis, Meta multiaplicativo, credenciais reais, tag, push, publicação externa ou deploy. O mapper HTTP seguro de erros/versionamento pertence à Fase 3, que depende de confirmação explícita do usuário.

## Onboarding pelo painel — Fase 3 concluída

- Criado o domínio `src/modules/onboarding/` com progresso do wizard, política de prontidão, validadores, serviço de aplicação, erros públicos sanitizados e repositório PostgreSQL tenant-scoped.
- O backend passou a produzir checks estáveis com `code`, `state`, `severity`, `step`, `message` e `correctiveAction` para identidade, retenção, módulos e dependências, menus e ações, serviços, pagamentos, fluxos, IA, WhatsApp/Meta, administrador, integrações e compilação.
- Tenants ativos no modo legado recebem diagnóstico e avisos sem suspensão automática. Novas publicações e ativações sempre recalculam a prontidão em modo `enforcement`.
- A capacidade `flows` permanece bloqueada por `FLOW_RUNTIME_AVAILABLE` até a Fase 4, impedindo que o loader atual receba uma revisão que ainda não consegue executar.
- Publicação e ativação agora bloqueiam tenant e draft, verificam a versão otimista, recalculam readiness, compilam, inserem a revisão imutável, trocam o ponteiro ativo, auditam e, na ativação, alteram o status na mesma transação.
- Falha de readiness, compilação, persistência ou auditoria reverte todos os efeitos. A empresa ativa que tenta publicar um draft incompleto permanece ativa na revisão anterior, sem suspensão automática.
- Criação e edição genéricas de empresas deixaram de aceitar `status`; novas empresas nascem em `draft`. A antiga ativação administrativa por simples troca de status foi removida do caminho HTTP.
- Administradores do tenant podem manter progresso, draft, validação e publicação da própria empresa; ativar ou reativar o tenant continua restrito ao administrador da plataforma, preservando o controle sobre suspensões.
- Foram adicionadas rotas de progresso, catálogo de ações, draft, validação, publicação, readiness e ativação. `preflight`, simulador, executor de flows, Meta multiaplicativo e wizard visual permanecem nas fases posteriores previstas.
- Erros de concorrência e readiness retornam somente códigos, issues, versões e checks allowlisted; segredos, SQL, payload de credenciais e causas internas não são expostos.
- `npm test` aprovou 249 de 257 testes, com oito integrações opcionais ignoradas; 168 arquivos JavaScript passaram em `node --check`; os cinco cenários de carga terminaram sem falhas; e o Compose foi validado com valores sintéticos.
- Na pilha isolada `waia-fase3`, as sete integrações PostgreSQL reais passaram, incluindo bloqueio de tenant incompleto, rollback, ativação atômica, auditoria, revisão versionada, RLS, mídia e operação. API, worker, PostgreSQL e Redis ficaram saudáveis e `/health/ready` retornou HTTP 200.
- API e worker não receberam `POSTGRES_PASSWORD` nem `DATABASE_MIGRATOR_URL`. Os containers foram parados após a validação sem remover volumes. Não houve credencial real, Filaretti, tag, push, publicação externa, deploy ou alteração da `main`.
- A Fase 4 — fluxos configuráveis — só deve começar após confirmação explícita do usuário.

## O que está comprovadamente implementado

- API Express com webhook Meta, autenticação administrativa, CSRF, autorização, páginas legais e health checks.
- Worker com outbox PostgreSQL, BullMQ/Redis, locks por conversa, concorrência por tenant, retries, backoff, dead-letter e heartbeat.
- PostgreSQL como fonte de verdade, com dezessete migrações, chaves compostas por tenant, idempotência, índices e `ENABLE/FORCE ROW LEVEL SECURITY`.
- Resolução do tenant por `metadata.phone_number_id`; API e worker oficiais não usam credenciais Meta globais.
- Conversas, mensagens, estados, pedidos, agendamentos, uso de IA, logs e auditoria persistentes.
- Runtime configurável com catálogo, eventos, pedidos, agenda, pagamentos, handoff e IA.
- Painel administrativo estático com login, dashboards e CRUDs centrais.
- Cofre de credenciais AES-256-GCM com AAD, versionamento, rotação, revogação, máscara e auditoria atômica.
- Tenant demonstrativo do Capitão Mor em seed sintético, sem credenciais, PIX ou dados pessoais reais.
- OpenAI Responses API com isolamento por tenant, limites, contingência, defesa contra prompt injection e contabilização de custo.
- Google Sheets multiempresa ligado ao runtime oficial: configuração e JSON por tenant no cofre, importação periódica de agenda/configurações públicas, último cache válido e exportação assíncrona de pedidos.
- Comprovantes privados em JPEG, PNG, WEBP ou PDF até 10 MB, com download Meta autenticado por tenant, SHA-256, retenção e visualização auditada no painel.
- Atendimento humano no painel com assunção da conversa, CSRF, autorização, idempotência, mensagem/outbox/auditoria transacionais e envio assíncrono pelo número do tenant.
- Gestão de jobs falhos no painel, restrita a administradores, com consulta sanitizada, retry por novo job, resolução explícita e auditoria transacional.
- Métricas Prometheus protegidas por Bearer dedicado, com contadores/durações compartilhados entre API e worker no Redis e gauges reais do PostgreSQL, BullMQ e heartbeats.
- Menus, eventos, compras, serviços e horários paginados sem perda de opções; o gateway usa botões até três escolhas e mensagens de lista entre quatro e dez.

## Correções desta auditoria

- Corrigido erro de sintaxe que impedia o JavaScript do painel de carregar.
- O painel agora interpreta corretamente erros administrativos estruturados, sem exibir `[object Object]`.
- Cookies malformados deixam de causar erro 500 durante autenticação.
- Restrições do PostgreSQL na API administrativa agora retornam erro público 400/409, sem expor SQL interno.
- API e worker deixaram de tentar conectar duas vezes o mesmo cliente Redis; ambos agora iniciam no Compose.
- O diagnóstico de heartbeat percorre todos os cursores do `SCAN` antes de declarar o worker indisponível.
- A perda do lease de concorrência por tenant interrompe o job, evitando conclusão concorrente sem posse do slot.
- A abertura concorrente da primeira conversa passou a usar `ON CONFLICT`, evitando erro transitório no webhook.
- `ultima_mensagem_at` passou a ser monotônico, impedindo regressão por mensagens recebidas fora de ordem.
- O fluxo de agenda preserva a etapa quando recebe um horário inválido.
- Pedidos agora exigem comprovante de imagem/documento realmente persistido, evento publicado e preço atual do banco.
- Pedidos e agendamentos passaram a usar lock de idempotência transacional.
- Agendamentos agora vinculam uma disponibilidade real e reservam/liberam capacidade atomicamente por trigger PostgreSQL; overbooking é rejeitado.
- O catálogo de preços da IA agora inclui o modelo padrão `gpt-4.1-mini`, evitando falha de toda chamada real antes do provedor.
- Corrigidos textos corrompidos em rotas administrativas e scripts sensíveis.
- O histórico `codex-session-*.md` foi excluído do contexto de build Docker, reduzindo o envio de aproximadamente 3,5 MB para cerca de 240 KB no primeiro rebuild.
- `.env.example` agora indica `INFRASTRUCTURE_MODE=postgres`, coerente com os executáveis oficiais.
- `npm start` e `npm run dev` agora apontam para a API oficial; a demonstração antiga exige `npm run start:legacy` ou `npm run dev:legacy`.
- Corrigida a falsa separação de papéis PostgreSQL: a configuração anterior transferia banco e objetos ao `waia_app`, concedia `CREATE` e executava migrações com a credencial da aplicação.
- Migrações agora exigem `DATABASE_MIGRATOR_URL`; API e worker recebem apenas `DATABASE_URL` do papel restrito e não recebem a senha do owner.
- O bootstrap repara volumes antigos, devolve propriedade ao owner, revoga `CREATE` e `TEMP` do papel da aplicação e mantém privilégios DML por grants atuais e default privileges.
- Adicionado teste PostgreSQL real para propriedades do papel, negação de `CREATE TABLE`/`ALTER TABLE` e isolamento RLS entre dois tenants sintéticos.
- O worker agora baixa a mídia da Meta antes de permitir que o pedido avance, inclusive quando a conversa está em atendimento humano; pedido PostgreSQL rejeita comprovante sem arquivo e checksum persistidos.
- Adicionado armazenamento privado por tenant, compartilhado entre API e worker, com metadados de MIME, tamanho, SHA-256 e data no PostgreSQL.
- O painel passou a visualizar comprovantes por endpoint autenticado e autorizado, com auditoria, `no-store`, `nosniff` e URL `blob:` temporária.
- MIME ou tamanho recusado gera orientação determinística ao usuário e não chama runtime nem IA; bytes de comprovantes nunca são enviados à OpenAI.
- A retenção remove arquivos privados associados às mensagens anonimizadas.
- Adicionado `media-init` para corrigir a propriedade do volume sem elevar os privilégios da API ou do worker; `.gitattributes` fixa scripts Alpine em LF no Windows.
- O operador que assumiu uma conversa agora pode responder pelo painel; outro operador, conversa fora do modo humano, contato bloqueado ou número inativo são recusados no backend.
- Cada clique usa UUID v4 persistido: repetição da mesma requisição devolve a mensagem existente e não cria outra mensagem nem outro job.
- A API retorna `202` somente depois de gravar mensagem, outbox e auditoria na mesma transação; falha de auditoria reverte a operação.
- O worker processa `send_human_message`, envia pelo número/credencial Meta do tenant e mantém retry, dead-letter e estados de entrega/leitura sem carregar texto ou segredos no Redis.
- A conversa no painel passou a mostrar as 100 mensagens mais recentes em ordem cronológica e o compositor reutiliza a chave de idempotência após falha ambígua de rede.
- O painel ganhou uma área exclusiva para jobs falhos, filtrada por tenant e aberta por padrão apenas nos incidentes não resolvidos.
- O detalhe operacional não retorna o payload bruto; mostra apenas tipo, referências, erro sanitizado, tentativas, correlação e estados do job original/novo.
- O retry manual não reutiliza o ID retido pelo BullMQ: cria uma nova outbox pendente, reenfileira a mensagem somente se ela ainda estiver em `falhou` e encerra o incidente original.
- A resolução sem retry encerra somente o alerta; ela não transforma uma mensagem falha em sucesso.
- Retry e resolução exigem motivo, papel administrativo, CSRF e auditoria na mesma transação PostgreSQL; falha da auditoria reverte a decisão.
- O registry de métricas passou a rejeitar nomes inválidos e valores não finitos/negativos, impedindo labels improvisadas e cardinalidade por identificador.
- Webhook, requisições HTTP, dispatcher da outbox e processor do worker agora alimentam contadores de sucesso/falha/retry/duplicidade e resumos de duração sem bloquear o fluxo principal.
- API e worker escrevem no mesmo namespace Redis; o endpoint `/metrics` agrega esses eventos com filas BullMQ, workers ativos e estados duráveis de mensagens, outbox, dead-letter, tenants e uso de IA.
- A coleta exige `METRICS_BEARER_TOKEN` com pelo menos 32 caracteres em produção, compara o token em tempo constante e responde com `no-store` e formato Prometheus.
- Nenhuma métrica possui label ou valor de tenant, usuário, conversa, mensagem, telefone, correlação ou conteúdo.
- Removido o corte silencioso das opções após o terceiro botão; conjuntos acima de dez são paginados em blocos de oito com navegação anterior/próxima.
- IDs internos de paginação usam um prefixo impossível na configuração do tenant, evitando colisão ou imitação por item administrativo.
- O mesmo payload interativo completo atravessa runtime, persistência da resposta e worker; o gateway escolhe botão ou lista somente no limite do transporte.
- Títulos, descrições e corpo interativo são ajustados aos limites do WhatsApp sem alterar os IDs determinísticos, e o envio falha explicitamente se receber mais de dez linhas não paginadas.
- Respostas `list_reply` do webhook passam pelo mesmo parser e roteador das respostas de botão, inclusive nas páginas de eventos e horários com estado persistido.
- O Capitão Mor preserva os contratos `Agenda!A2:I`, `Configurações!A2:C` e `Pedidos!A:G`; PIX/favorecida não são importados da planilha e permanecem no cofre.
- A sincronização cria/atualiza eventos e convites no PostgreSQL, cancela/desativa itens removidos e ignora eventos inativos ou passados.
- O worker executa sincronização por tenant a cada 120 segundos por padrão e exporta pedidos por outbox contendo apenas IDs, com checkpoint idempotente e isolamento RLS.
- O painel recebeu configuração dedicada do Google Sheets, rotação do JSON da conta de serviço e sincronização imediata auditada.
- Adicionado `docs/CONFIGURACAO_INTEGRACOES.md` com o fluxo de configuração Meta, OpenAI, Google Sheets e segredos de infraestrutura.
- Corrigido o mapeamento do usuário ao reabrir uma sessão PostgreSQL: a consulta retorna `user_id_value`, e o repositório agora preserva esse ID nas requisições administrativas posteriores ao login.
- Foram removidas, com autorização explícita, 24 empresas `Tenant A`/`Tenant B` e 24 contatos com slugs exclusivos `priv-a-*`/`priv-b-*`, resíduos dos testes de isolamento; nenhum outro dado foi atingido.
- Corrigida a leitura da configuração operacional: o descritor PostgreSQL de `configuracoes_empresa` não consulta mais a coluna inexistente `created_at`, preservando somente `updated_at` como definido pela migração.
- Corrigida a ação de estado das empresas no painel: tenant em `draft` agora oferece **Ativar**, tenant ativo oferece **Suspender** e tenant suspenso oferece **Ativar**.
- O painel de números passou a permitir completar E.164/WABA/nome, ativar e definir o principal; o backend exige token Meta ativo antes da ativação, mascara o número e troca o principal na mesma transação auditada.
- A configuração de IA agora devolve o estado real da credencial própria vinculada; o painel deixa de exibir `not_configured` quando a chave OpenAI está ativa no cofre.
- Corrigido o salvamento dos módulos no painel: os checkboxes agora são capturados antes da confirmação assíncrona, evitando o uso de `event.currentTarget` já invalidado e garantindo o envio do `PUT`.
- A tela de módulos e configurações agora oferece **Adicionar Google Sheets** quando a integração ainda não existe, cria o registro inicial e abre diretamente o formulário seguro da planilha.
- O cofre administrativo agora aceita segredos multilinha, como o JSON formatado de contas de serviço Google, preservando limite de tamanho e rejeição de caracteres de controle inseguros na criação e rotação.
- Recibos Meta referentes a mensagens externas ou anteriores ao banco local agora são registrados e concluídos como ignorados, sem retries nem incidentes falsos; mensagens realmente enviadas pelo WAIA continuam recebendo os estados `sent`, `delivered` e `read` normalmente.
- O menu real do Capitão Mor foi restaurado com três ações canônicas e roteamento determinístico/IA; a saudação inicial volta a sair como botões e textos livres deixam de repetir indefinidamente a mensagem de boas-vindas.
- O carregador PostgreSQL do runtime deixou de executar `Promise.all` sobre um único client transacional, eliminando a concorrência não suportada e o aviso de depreciação observado no primeiro teste real.
- O worker agora preserva o `selectionId` de respostas interativas; botões deixam de cair no fallback da IA. O roteamento também reconhece aliases dentro de frases naturais e o Capitão Mor ganhou cópia direta para cardápio, seleção da noite, evento, PIX, comprovante e contingência.
- Os fluxos conversacionais passaram a aceitar novas intenções antes da etapa pendente: trocar sexta por sábado substitui o evento, perguntas naturais com dia abrem a programação correspondente e `oi` reinicia o menu. Respostas livres da IA recebem apenas a base pública do tenant, sem PIX/credenciais, usam o histórico e terminam com uma pergunta configurável.
- `MASTER_KEYRING` passou a ser interpolado como escalar YAML citado no Compose; isso preserva as duas chaves finais do JSON em versões recentes do Docker Compose e evita o ciclo de reinício da API/worker observado após uma recriação.
- A área **Módulos e configurações → Identidade e atendimento** ganhou o campo multilinha **Regras do estabelecimento**, persistido por tenant e auditado pelo fluxo administrativo existente.
- As regras do Capitão Mor foram cadastradas com as restrições de vestimenta e a política de aniversariante solicitadas; o backfill usa o `slug` único da empresa e preserva regras já preenchidas em outros tenants.
- O carregador inclui as regras em `TenantRuntimeConfig.identity`; o worker as envia somente dentro do contexto público permitido da empresa, processado pela IA sob as guardrails imutáveis da plataforma e sem PIX, credenciais ou mídia privada.

## Validação executada

- `npm test`: 202 testes descobertos; 196 aprovados e 6 integrações opcionais ignoradas sem infraestrutura.
- `node --check`: 140 arquivos JavaScript válidos.
- `npm run load:test`: cinco cenários sintéticos aprovados, de 250 a 800 jobs, sem falhas.
- `docker compose -p waia-today config --quiet`: configuração válida com valores sintéticos.
- Build Docker das imagens de API e worker concluído; instalação reportou zero vulnerabilidades npm.
- PostgreSQL 16 e Redis 7 iniciados em uma pilha temporária isolada.
- Migração incremental concluída; dezesseis migrações descobertas, com `015_establishment_rules.sql` e `016_capitao_mor_establishment_rules.sql` aplicadas uma vez cada.
- Teste de integração real comprovou incremento de capacidade, rejeição de overbooking e liberação após cancelamento.
- API e worker iniciados com `NODE_ENV=production`; ambos ficaram saudáveis.
- `GET /health/ready` retornou HTTP 200.
- O teste real confirmou `waia_app` como `NOSUPERUSER`, `NOCREATEDB`, `NOCREATEROLE` e `NOBYPASSRLS`, sem `CREATE` no schema e sem `TEMP` no banco; tentativas de `CREATE TABLE`, `ALTER TABLE` e escrita em outro tenant foram rejeitadas.
- A inspeção dos contêineres confirmou ausência de `POSTGRES_PASSWORD` e `DATABASE_MIGRATOR_URL` na API e no worker.
- Bootstrap e migrações foram repetidos no mesmo volume: execução idempotente e `0` de `13` migrações reaplicadas.
- Três integrações PostgreSQL reais passaram: privilégios/RLS, capacidade da agenda e metadados/arquivo privado de mídia.
- A quarta integração PostgreSQL real comprovou resposta humana idempotente e auditada, falha final, listagem sanitizada do dead-letter, retry por novo job e resolução sem alterar falsamente o estado da mensagem.
- Redis real recebeu o job `send_human_message` contendo somente IDs, tipo, correlação e versão do payload.
- Redis real acumulou contador e resumo de duração compartilhados; o endpoint real recusou acesso sem Bearer com HTTP 401 e retornou HTTP 200 apenas com token sintético.
- O scrape real exibiu `waia_metrics_collector_up 1`, um heartbeat de worker e gauges atuais de outbox/BullMQ sem labels de alta cardinalidade.
- API e worker montam o mesmo `media_data`, permanecem como usuário `node` e ficaram saudáveis; `/health/ready` retornou 200.
- A imagem Docker reconstruída aprovou 36 testes direcionados de runtime, persistência/worker, gateway e parser interativo; API e worker permaneceram saudáveis e `/health/ready` retornou 200.
- Cinco integrações PostgreSQL reais passaram na imagem reconstruída, incluindo sincronização sintética da agenda Google com RLS e desativação de evento removido.
- A nova tabela `integracao_operacoes` foi comprovada com privilégios DML do papel restrito e `ENABLE/FORCE ROW LEVEL SECURITY`; API retornou `/health/ready` 200 e worker permaneceu saudável sem credencial Google real.
- O teste de regressão do repositório PostgreSQL confirmou que a sessão reconstruída mantém o ID do usuário.
- Após reconstruir a API, uma sessão administrativa temporária e imediatamente removida recebeu HTTP 200 em `/api/admin/auth/session`, `/api/admin/tenants` e `/api/admin/dashboard`.
- Após a correção da configuração operacional e novo build da API, uma sessão administrativa temporária e imediatamente removida recebeu HTTP 200 nos cinco recursos usados pela tela: módulos, IA, integrações, configuração operacional e credenciais; o container permaneceu saudável.
- A regressão direcionada das regras aprovou 55 de 55 testes; ela comprovou formulário, descritor administrativo, parsing do runtime, envio ao contexto processado pelo modelo e exclusão dos dados privados de pagamento.
- No PostgreSQL real, a nova coluna foi criada e o tenant `capitao-mor` recebeu 294 caracteres de regras; após rebuild, API e worker permaneceram saudáveis e `/health/ready` retornou HTTP 200.

O teste de carga continua sendo uma regressão em memória; ele não mede capacidade de VPS, latência de rede ou limites dos provedores.

## Lacunas e riscos ainda existentes

### Bloqueiam produção

- Meta, OpenAI e Google ainda precisam de credenciais exclusivas de homologação e teste externo real nesta base SaaS; nenhuma credencial antiga foi copiada automaticamente.
- 2FA/MFA possui colunas no banco, mas não tem fluxo de cadastro, desafio ou recuperação.
- Backup e, principalmente, restauração ainda não foram exercitados em uma cópia descartável do ambiente alvo.
- O download de mídia foi validado com provedor simulado e armazenamento real, mas ainda precisa de homologação com um número Meta exclusivo de teste.

### Riscos técnicos relevantes

- O envio Meta é `at-least-once`: uma queda depois de a Meta aceitar a mensagem e antes do checkpoint no banco pode duplicar a resposta.
- Um webhook muito grande é processado sequencialmente, com uma transação por evento, podendo pressionar o tempo de ACK.
- A validação administrativa ainda depende de algumas constraints do banco para domínios e limites; o erro agora é seguro, mas a UX deve validar antes da escrita.
- Cabeçalhos HTTP estão razoáveis com Helmet, mas CSP do app está desabilitada e a política do proxy ainda precisa de hardening para produção.
- O arquivo `codex-session-01a044fd-4841-73b3-b456-d9d028928dee.md` tem cerca de 2,7 MB e permanece na raiz. Não foi removido por pertencer ao histórico do usuário.
- O volume local `media_data` é adequado para homologação em host único, mas deve entrar no backup/restauração e ser substituído ou replicado se a produção usar múltiplos workers/hosts.
- Contadores e resumos operacionais usam Redis e podem reiniciar se o volume for perdido; Prometheus deve tratar essa queda como reset de contador. Gauges de estado são recalculados das fontes reais a cada scrape.
- O repositório Git está presente, na branch `main`, conectado a `origin`; as mudanças desta continuidade permanecem locais e ainda não foram commitadas.
- A entrada legada mantém endpoints de diagnóstico/sincronização sem autenticação e aceita webhook sem assinatura quando não há segredo; ela não deve ser exposta nem usada como produção.

## Plano para concluir o projeto

### Fase 1 — fechar o núcleo operacional

1. Configurar no painel a planilha e as credenciais exclusivas do Capitão Mor e executar a homologação externa controlada.

### Fase 2 — segurança e recuperação

2. Implementar MFA para administrador da plataforma, incluindo recuperação segura.
3. Endurecer CSP, HSTS e demais cabeçalhos no Caddy/Nginx após definir os domínios reais.
4. Expandir a integração contínua PostgreSQL/Redis, agora já cobrindo privilégios, RLS, agenda, jobs falhos e métricas, para concorrência de webhook e pedidos.
5. Validar backup e restauração ponta a ponta em banco descartável, documentando RPO/RTO e rollback de migração.
6. Retirar o artefato de sessão da raiz somente após autorização do usuário.

### Fase 3 — homologação e produção

7. Subir uma homologação isolada com domínio, TLS, volumes, monitoramento e credenciais exclusivas de teste.
8. Cadastrar duas empresas completas e provar isolamento de números, credenciais, mensagens, limites, painel e integrações.
9. Homologar Meta, OpenAI e Google com dados sintéticos; testar retries, indisponibilidade e limites reais.
10. Executar teste ponta a ponta: webhook assinado → persistência/outbox → worker → resposta Meta → status de entrega/leitura.
11. Fazer revisão LGPD/retenção, runbook de incidentes e checklist de go-live antes de qualquer tráfego real.

## Decisões que ainda dependem do usuário/produto

- Confirmar a planilha real do Capitão Mor e manter o desenho implementado: importação complementar de agenda/configurações públicas e exportação de pedidos, com PostgreSQL como verdade operacional.
- O painel WAIA já cobre o atendimento humano mínimo; ainda deve ser decidido se haverá integração futura com uma caixa externa.
- Qual provedor/estratégia será adotado para reduzir duplicidade no envio Meta?
- Quais domínio, VPS, RPO/RTO, política de retenção e orçamento por tenant serão usados?
- O artefato de sessão da raiz pode ser removido?
- Existem dois administradores de plataforma ativos; confirmar se a conta adicional criada para teste deve ser removida.

Nenhuma credencial real foi lida, exposta ou usada nesta auditoria.
