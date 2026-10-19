# Notificações de leads em grupos — remetente central WAIA

## Coleta comercial com catálogo — candidata v1.21.2, 19/10/2026

ALFATECH configurada pelo painel para qualificação com nome, cidade, produto identificado e interesse inequívoco após esclarecer dúvidas. Revisão 56 publicada como configuração 27, grupo `teste` habilitado/revisão 1 e remetente conectado. O catálogo continua acessível antes da coleta. Configuração atual 28 preservada: alteração posterior somente em `/identity/fallbackMessage`.

O teste real não chegou a criar ficha nem pendência: OpenAI retornou `AI_INVALID_CATALOG_SELECTION` às 15h42min46s locais, com 91 tokens de saída/limite 800. A contingência foi entregue/lida; o bot não pausou. JSON bruto não é retido, portanto o campo recusado é desconhecido. Não houve falha de transporte do grupo demonstrada nesse teste.

Reprodução sintética: a coleta (`catalogAction=none`) com referência válida ao produto no array de IDs era rejeitada. Agora, exclusivamente quando a triagem está habilitada, esses IDs/filtros válidos são tratados como contexto sem efeito operacional: responde em texto, sem foto, pausa ou ficha. IDs inexistentes, duplicados, envelope/limites, categorias/faixas inválidas e texto vazio continuam rejeitados. Empresas sem triagem preservam o contrato antigo. Na triagem, a ação antiga `interest` é removida do schema/contexto e bloqueada no parser mesmo que o campo anterior permaneça preenchido. Conclusão usa somente a ficha validada e o encerramento configurado; persistência/outbox seguem a transação já existente.

Quatro testes novos (dois falhavam antes da correção); 41 casos direcionados aprovados, incluindo coleta com contexto, validações, ausência de repetição/pausa, catálogo em três fichas, detalhe técnico e conclusão válida. Candidata isolada de HEAD/265f098, sem equipe/MFA, em Node 22: 567 casos, 547 aprovados, 20 skips opt-in, zero falhas; whitespace aprovado. Sem migração, dependência ou escrita SQL nova; sem repetição de testes PostgreSQL porque a persistência não mudou. Entrega externa de novo lead ALFATECH depende de teste após deploy autorizado. Nenhuma chamada OpenAI/WhatsApp adicional pela operação, reset de contato ou reenvio antigo.

Nove arquivos: `src/modules/ai/ai-service.js`, `src/modules/business/catalog-sales.js`, `src/modules/group-notifier/qualification.js`, `test/group-notifier.test.js`, `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md` e este documento. Equipe/MFA excluídos. Commit proposto: `fix: v1.21.2 preserva coleta comercial antes de notificar lead`. Commit/push de dev e deploy autorizados em 19/10/2026 após revisão dos nove arquivos e validações; execução em andamento. Evidência final local em `.tmp/DEPLOY_V1.21.2_20261019.md`.

## Correção de contingência e roteiro — candidata v1.21.1, 18/10/2026

Diagnóstico real da Filaretti, configuração 11: às 23h02 de 18/10/2026 (America/Sao_Paulo), a entrada identificada pelo texto “residencial” teve resposta OpenAI e falhou na validação `AI_INVALID_LEAD_QUALIFICATION`. Foram 3480 tokens de entrada e 111 de saída, abaixo do limite 400. Outro erro igual ocorreu às 22h54. Não houve evidência de timeout, esgotamento de tokens ou queda da API nesses dois registros. O JSON bruto não é armazenado: o código da falha é comprovado, mas o campo exato que causou a rejeição não pode ser recuperado dessa evidência.

A implementação anterior validava comprimentos da ficha mesmo durante coleta, exigia texto conversacional não vazio antes de aproveitar uma ficha completa e convertia qualquer rejeição dos metadados em contingência geral. O roteiro também pedia reconhecer um fato antes de perguntar e dizia que o nome era opcional, embora o encaminhamento automático exija nome. Esses caminhos foram reproduzidos com dados sintéticos; não são apresentados como captura do JSON real.

Na candidata patch v1.21.1:

- Coleta e casos fora do escopo descartam os metadados parciais, sem exigir ficha concluída. Ficha completa continua exigindo todos os campos válidos e evidência do nome em mensagem do cliente.
- Ficha válida usa o encerramento configurado mesmo se o modelo retornar `text` vazio. Não depende de produtos/ações comerciais que serão descartados nesse encerramento.
- Ficha marcada como concluída, mas inválida, não cria lead, não pausa nem agenda envio ao grupo. Usa uma única pergunta de continuação adequada, retirando recapitulação em parágrafo anterior e recusando promessas de encaminhamento/fechamento. Sem nova chamada OpenAI ou retry automático; tokens da resposta são contabilizados uma vez.
- Evento sanitizado `ai_qualification_deferred` registra somente motivo categorizado (`NAME`, `NAME_EVIDENCE`, `SUMMARY`, `QUALIFICATION`) e referências operacionais. Não registra texto, nome, resumo, JSON ou segredo do provedor. Envelope ilegível, resposta truncada e configuração inválida continuam bloqueados.

Roteiro ajustado **pelo painel e publicado na configuração 12**, rascunho 57: voz feminina da Laís, uso contextual de “obrigada”, “pronta” e “grata”, sem inferir gênero do cliente. Resposta a uma informação deve avançar diretamente para a próxima pergunta útil, sem agradecer ou recontar data/situação a cada turno. Removida a regra que exigia reconhecer um fato antes de perguntar e alinhado nome necessário para notificação, respeitando recusa. Somente `/ai/prompt` foi alterado; modelo, limite 400, credencial, critérios e destino permaneceram. Prompt ativo SHA-256 `b0f7dfe04863e429b8fb5d741dfa7625255bfdc033f70d2934ff57db7fa4e97b`. Remetente conectado e grupo “teste” habilitado; versão do vínculo observada 2, sem alteração nesta correção.

Validações: candidata isolada sem equipe/MFA em Node 22 com 563 casos, 543 aprovados, 20 skips opt-in e zero falhas. Inclui 16 casos específicos de notificações: coleta parcial, ficha válida sem texto redundante, nome não comprovado, resumo/classificação incompletos, ausência de promessa falsa, bloqueio de truncamento/envelope inválido, consumo único, logs sem conteúdo pessoal e composição com catálogo. Checkout completo Node 24 passou antes da última adição do caso de catálogo, que passou separadamente e na candidata final. Whitespace e manifests 1.21.1 conferidos. Sem migração, dependência ou alteração SQL; integrações PostgreSQL/Redis não repetidas. Nenhuma chamada OpenAI/WhatsApp, reenvio ou reset da conversa do print foi feito; os testes sintéticos não comprovam o comportamento real das próximas respostas.

Arquivos da correção: `src/modules/ai/ai-service.js`, `src/modules/group-notifier/qualification.js`, `test/group-notifier.test.js`, `package.json`, `package-lock.json`, este documento, `PLAN.md` e `RELATORIO.md`. Equipe/MFA preservados fora da candidata. Versão 1.21.1 somente local; commit/push/deploy dependem de confirmação após revisão. Mensagem proposta: `fix: v1.21.1 evita contingência por ficha parcial de lead`.

O registro abaixo descreve a entrega original v1.21.0, já commitada e publicada como `ef9bd06`; evidência operacional em `.tmp/DEPLOY_V1.21.0_20261018.md`.

Atualizado em 18/10/2026. Candidata local **v1.21.0**, sobre HEAD `6f62fb1` / v1.19.1. Sem commit, push ou deploy desta candidata.

Após a revisão abaixo, usuário autorizou commit `feat: v1.21.0 notificações de leads por empresa` e push de dev em 18/10/2026. Execução em andamento, com evidência final em `.tmp/COMMIT_V1.21.0_20261018.md`. Deploy e promoção de main não fazem parte dessa autorização.

## Decisão e estado

Um número dedicado da WAIA notifica grupos separados por empresa. Cada empresa mantém seu conector atual de atendimento. A Filaretti começa com o critério aprovado: nome informado, relato suficiente e enquadramento na área atendida, para análise humana, sem avaliar direitos ou chances de êxito.

O piloto local por QR foi conectado e o usuário confirmou o funcionamento nesta conversa. Ele continua separado, com sessão e vínculos em memória. A candidata integra triagem, persistência e envio ao produto; não importa a sessão nem as referências locais do piloto. Ainda exige publicação e teste externo do fluxo persistente com lead autorizado. Não conclui F5 nem libera outras fases do SaaS.

## Fluxo implementado

1. Cada empresa habilita a triagem e salva/publica critérios e encerramento no onboarding versionado. A ausência desses campos mantém checksum e comportamento de configurações antigas.
2. A IA retorna resposta e ficha estruturada: coleta/fora do escopo/qualificado, nome, resumo e qualificação operacional. O sistema valida os campos e exige evidência do nome em mensagem do cliente. Telefone vem do contato; grupo vem da associação administrativa, nunca da IA.
3. Quando qualificado, o sistema usa o encerramento configurado. Somente após confirmação do provedor com identificador, a mesma transação registra uma ficha por conversa, cria a pendência de envio e pausa o bot. Posse humana anterior impede a conclusão automática.
4. Um processo separado confirma participação/permissão no grupo e revalida empresa, contato, número, configuração publicada e versão do destino antes de iniciar o envio. Mudanças de destino cancelam pendências anteriores; não as redirecionam silenciosamente.
5. A notificação contém empresa, **nome, resumo do caso, qualificação e número do lead**. O painel mostra pendente, enviando, aceito, sem confirmação ou cancelado. Aceito pelo conector não comprova entrega/leitura pelos participantes.

## Operação pelo painel após publicação autorizada

1. Aplicar `025_group_notifications.sql` pelo migrador habitual e publicar API/painel/worker da mesma candidata. Preservar o cofre existente. A migração 023 de equipe/MFA não integra esta candidata.
2. Habilitar o serviço opcional `group-notifier` do Compose (`--profile group-notifier`). Ele usa o papel restrito da aplicação e o cofre existente. Não exige `.env`, SQL, reinício ou deploy por empresa. Essa ativação de infraestrutura não foi feita em produção nesta entrega.
3. Como administrador da plataforma, abrir **Notificações e leads**, informar número dedicado com `+55` e DDD, confirmar seu uso e gerar o QR. Ler em **Aparelhos conectados → Conectar aparelho**. A sessão persistente exige novo vínculo: não interromper o piloto antes da transição combinada.
4. Adicionar o número dedicado aos grupos autorizados pelo aplicativo. Grupo restrito a administradores exige permissão de envio. O número lido deve coincidir com o informado.
5. Selecionar a empresa, escolher o grupo e habilitar/salvar o destino. Um grupo só pode estar associado a uma empresa, inclusive desabilitado. Trocar o número dedicado exige revisar/salvar os vínculos para o novo remetente.
6. No **Onboarding → IA**, habilitar triagem, revisar critérios com a área atendida e o encerramento, salvar rascunho e publicar/ativar. A prontidão impede publicação de triagem sem IA e destino habilitados. Nenhuma configuração da Filaretti foi publicada por esta implementação.
7. Fazer atendimento de teste autorizado. Conferir resposta ao cliente, pausa, ficha correta e recebimento no grupo da mesma empresa. Repetir com outra empresa/grupo autorizados antes de declarar o roteamento externo multiempresa comprovado.

Critério inicial da Filaretti: “Nome informado, relato suficiente do caso e enquadramento na área atendida pela empresa. Encaminhar para análise humana, sem avaliar direitos ou chances de êxito.” Encerramento padrão: “O responsável irá analisar seu caso e retornar por aqui. Por favor, aguarde o retorno.” Ambos são configuráveis pelo painel.

Empresas consultam somente seus destinos e leads. Sessão, QR, lista global de grupos e alteração dos vínculos são exclusivos da plataforma. A tela mostra os 100 leads mais recentes, com atualização manual para preservar formulários; conexão/QR atualizam automaticamente.

## Persistência, recuperação e privacidade

- Sessão/Signal keys persistem no cofre AES-GCM, vinculadas à geração. QR temporário também é cifrado e servido como imagem somente a administrador autenticado, com `no-store`. Processo dedicado suprime logs diretos de bibliotecas que poderiam conter chaves.
- Lease exclusivo renovável no PostgreSQL, com bloqueio por geração/proprietário. Encerramento aguarda operações em curso antes de liberar o lease; parada normal conserva o vínculo cifrado.
- Tentativa persistida antes da chamada externa. Aceitação sem identificador, timeout ou reinício após início ficam **sem confirmação**, sem retry automático. Conferir o grupo antes de ação manual; não há botão de reenvio nem reconciliação automática com o WhatsApp nesta entrega.
- Falha de consulta do grupo antes da tentativa adia a pendência por 60 segundos e permite avançar outros destinos. Suspensão, bloqueio, anonimização, configuração incompatível e mudança de vínculo impedem envio. Mudança concorrente após início da chamada não desfaz mensagem já aceita.
- Fichas/pendências usam RLS forçada por empresa e FKs compostas. Material da sessão é exclusivo da plataforma. Cópias seguem retenção e anonimização do contato/resposta de origem. Isso não apaga mensagens já recebidas nos grupos; o titular administra o acesso pelo aplicativo.
- **Desconectar** invalida a geração e apaga material cifrado local, tentando revogar o aparelho remoto quando conectado. Se já estava indisponível, remover manualmente no celular. Não imprimir ou compartilhar QR/chaves em diagnóstico.

## Limites e rollback

Baileys `7.0.0-rc14` é um conector não oficial em pré-release, escolhido para este piloto. Não há comprovação de leitura por participante, SLA ou isolamento de falha do número central entre empresas. A sessão ignora atendimento recebido e sincronização de histórico; continua sendo um aparelho vinculado do WhatsApp Web.

Para interromper notificações, desabilitar destinos no painel e parar o serviço dedicado. Pendências da rota desabilitada são canceladas; tentativas em curso exigem conferência manual. Antes de retornar API/worker à v1.19.1, desabilitar triagem, publicar configuração compatível e concluir/cancelar respostas de triagem preparadas. Manter migração aditiva/registros, sem apagar banco/volumes. Revogação do número exige conferir Aparelhos conectados no celular.

## Evidência de validação

- Candidata isolada sem equipe/MFA: **Node 22, 557 casos, 537 aprovados, 20 skips opt-in, zero falhas**. Imagem Linux construída com dependências de produção; importação real do transporte, serialização tipada de credenciais, QR e API aprovadas sem rede/socket externo.
- PostgreSQL 16 no serviço existente `waia-test-postgres-1`: **11 casos aprovados**, migrações da candidata (24 arquivos, sem 023), banco e dois papéis temporários exclusivos. Cobriu RLS/FKs, grupo exclusivo, versão otimista, sessão/Signal cifrados e restaurados, rollback de escrita parcial, ficha/outbox/pausa atômicos, idempotência, lease, envio incerto, suspensão, rota, posse humana, anonimização e revogação. Processo dedicado iniciou com envio desativado e terminou liberando lease. Fixtures/banco/papéis removidos; dados/volumes existentes preservados; PostgreSQL devolvido parado.
- Checkout Node 24: 560 casos, 539 aprovados, 21 skips, zero falhas, antes do teste HTTP adicional; esse caso passou separadamente. Candidata final Node 22 acima já inclui HTTP. Skips não comprovam banco/Redis exercitados.
- Dez testes da integração e dez do piloto cobrem triagem, identidade, configuração legada, serialização, encerramento, falhas, autorização, autenticação/CSRF e QR sem payload bruto. Auditoria de produção: zero vulnerabilidades reportadas. Whitespace aprovado.
- Navegador com dados fictícios: QR, destino salvo, troca entre duas empresas, estado vazio e visão sem controles centrais para empresa conferidos. Prévia `.tmp/group-notifier-postgres/tela-leads.png`, somente dados fictícios. Layout móvel completo permanece pendente.
- Nenhuma chamada OpenAI, novo QR real, envio de lead real, ativação de serviço ou configuração de tenant em produção nesta integração. Aceite do piloto nesta conversa não comprova o fluxo persistente após publicação.

## Arquivos e revisão

Infraestrutura/documentação: `.gitignore`, `package.json`, `package-lock.json`, `docker-compose.yml` (somente serviço novo), `PLAN.md`, `RELATORIO.md`, este documento, `db/migrations/025_group_notifications.sql`, `src/group-notifier.js`.

Transporte/piloto: `src/integrations/whatsapp-web/group-session.js`, `scripts/group-notifier-pilot.mjs`, `src/modules/group-notifier/pilot-service.js`, `src/modules/group-notifier/pilot-http.js`, três arquivos de `panel/group-notifier-pilot/`.

Integração: `src/modules/group-notifier/{qualification,acknowledge-qualification,postgres-repository,admin-service,worker}.js`, `src/modules/admin/router.js`, `src/bootstrap/app-runtime.js` (somente grupos), `src/modules/ai/{ai-service,contracts,postgres-adapters}.js`, `src/modules/configuration/{tenant-runtime-config-v2,legacy-adapter}.js`, `src/modules/jobs/{handlers,sales-interest}.js`, `src/modules/runtime/router.js`, `src/modules/onboarding/{postgres-onboarding-repository,readiness-service}.js`.

Painel/testes: `panel/group-notifier.js`, `panel/onboarding.js`, `panel/app.js` e `panel/index.html` (somente notificações), `test/group-notifier.test.js`, `test/group-notifier-pilot.test.js`, `test/group-notifier-postgres.test.js`, `test/delivery-hardening.test.js`.

Equipe/MFA e seus trechos compartilhados permanecem preservados e fora da candidata. `.tmp/` contém apoio/evidência local e não integra o commit. Mensagem proposta, após confirmação explícita exigida pelo `AGENTS.md`: **`feat: v1.21.0 notificações de leads por empresa`**. Push de dev, promoção de main e deploy não executados.
