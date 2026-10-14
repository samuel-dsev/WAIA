# Continuidade — WAIA

Atualizado em 14/10/2026. Plano ativo: [WAIA_2.0.0.md](WAIA_2.0.0.md); sequência: [PLAN.md](PLAN.md).
Este relatório separa inspeção local, histórico de operação e trabalho ainda planejado.

## Reinício explícito da consulta de catálogo — 14/10/2026

- Base publicada: v1.18.1 / `c94edde`; ALFATECH na configuração 17. O último teste de catálogo encontrado em leitura (03:37 UTC) preparou/entregou só YALA: STARMEGA e HARLEY já constavam como lidas, e a v1.18.1 passou a excluí-las também de um novo pedido geral. A primeira tentativa anterior havia falhado apenas na imagem da YALA (131053). Catálogo atual saudável com os três produtos ativos, disponíveis e com foto; não há exclusão de linhas na planilha.
- Candidata patch v1.18.2: `browse` inicia nova consulta pelos três primeiros elegíveis e zera o cursor da página; `more` mantém filtro e avança três em três na mesma consulta; `products`/escolha preserva a proteção contra reenvio espontâneo. `presentedProductIds` deriva das confirmações da conversa inteira, enquanto `seenProductIds` contém somente o avanço da consulta corrente. Campo opcional no contexto, sem migração, dependência ou mudança do schema de resposta da IA.
- Roteiro alinhado pelo painel no rascunho 31, 15.993 caracteres: novo pedido explícito reinicia três primeiros; "mais opções" continua a consulta; escolha/detalhe não repete foto. Saudação e condições comerciais preservadas. Sem publicação nessa preparação.
- Candidata isolada Node 22: 519 casos, 501 aprovados, 18 skips, zero falhas. PostgreSQL real `waia-test` confirmou separação de histórico global e cursor de consulta, confirmações, falha posterior do provedor, cancelamento e isolamento. Registros sintéticos próprios removidos e PostgreSQL devolvido parado; volumes existentes preservados. Testes incluem dois produtos apresentados + novo pedido geral com três fichas, paginação 3/3/2, detalhe técnico e escolha sem foto repetida. Whitespace aprovado. Sem reset, exclusão de histórico, novo envio WhatsApp ou chamada OpenAI nesta preparação. Commit/push/deploy e publicação do roteiro explicitamente autorizados após apresentação dos 10 arquivos e validações; execução em andamento. Equipe/MFA fora do escopo; evidência final em `.tmp/DEPLOY_V1.18.2_20261014.md`.

## Fichas repetidas e saudação consistente — 13/10/2026

- Base efetivamente publicada: v1.18.0 / `edcf037`, configuração 13 da ALFATECH. Evidência operacional em `.tmp/DEPLOY_V1.18.0_20261013.md`; os registros abaixo de preparação são históricos. O primeiro teste real gerou as cinco partes, mas fotos falharam por URLs temporárias do Airtable indisponíveis (HTTP 410). O usuário resolveu os links depois e reportou repetição da Harley após "gostei da harley".
- Candidata patch v1.18.1: instruções distinguem interesse de solicitação de ficha; backend filtra IDs já apresentados em `products`, `browse` e `more`, retornando continuidade em texto quando só há modelos já vistos. Dúvidas técnicas continuam personalizadas em texto. Consulta recupera confirmações de todas as partes de produto da mesma empresa/conversa, atravessando filtros e checkpoints antigos. IDs apenas copiados no cursor não contam sem registro confirmado; falhas/cancelamentos/retentativas do lote mantêm as proteções anteriores. Sem migração ou dependência nova.
- Pelo painel, revisão atual 28 carregada para preservar o texto alterado pelo usuário. Saudação e menu passam a "Olá! Bem-vindo à Alfatech Taubaté. Como posso te ajudar hoje?", mantendo botão humano; roteiro recebe regra de continuidade após a escolha. Revisão 30 publicada como configuração 17, confirmada no runtime em leitura. Cidade permanece no encaminhamento; espera continua desativada e catálogo saudável. Alterações anteriores de equipe/MFA fora do escopo.
- Candidata isolada Node 22: 517 casos, 499 aprovados, 18 skips, zero falhas. PostgreSQL real em `waia-test` confirmou histórico entre filtros/checkpoints, isolamento, idempotência, exclusão de falha posterior do provedor e cancelamento. Registros sintéticos próprios removidos, volumes/dados existentes preservados e serviço devolvido parado. Whitespace aprovado. Não houve envio WhatsApp/OpenAI real da correção; commit/push/deploy v1.18.1 explicitamente autorizados após apresentação dos 10 arquivos e validações. Execução em andamento; evidência final em `.tmp/DEPLOY_V1.18.1_20261013.md`.

## Atendimento comercial do catálogo — 13/10/2026

- Pedido: perguntar modelo inicialmente; validar cidade ao encaminhar; enviar fichas sem pedir permissão; abertura e pergunta final separadas; três produtos por página na ordem da planilha; modelo/faixa de preço com dados da planilha; detalhes técnicos em resposta personalizada.
- ALFATECH: saudação, menu raiz, orientações públicas e roteiro de 14.116 caracteres salvos no rascunho (revisão 24), sem publicação. Condições comerciais, horários, três unidades, assistência, resumo e pendência do grupo preservados. Saudação/menu também alterados porque passam antes da IA.
- Preparada v1.18.0 compatível, opt-in `ai.catalogSalesEnabled`. Classificação estruturada da IA escolhe navegação, continuação, modelo específico, detalhe técnico ou atendimento normal; backend aplica categoria/faixa de preço aos dados atuais, decide os três produtos da página e monta abertura/fichas/pergunta. Detalhes técnicos seguem o texto da IA com os dados validados e o roteiro; a plataforma não inventa a característica ausente.
- Progresso isolado por empresa/conversa em metadados do checkpoint existente, sem migração: só IDs de fichas com confirmação de envio contam. Filtros preservados; falta de opções é explícita. Reentrada não repete prefixo/fichas já confirmados; pausa/suspensão/lease seguem as proteções anteriores. Retenção/reset do histórico elimina o progresso da consulta. Catálogo de menu determinístico e tenants sem a opção mantêm o contrato anterior.
- Candidata isolada Node 22: 514 casos, 496 aprovados, 18 skips, zero falhas; auditoria de produção zero vulnerabilidades. PostgreSQL real em `waia-test` confirmou cinco partes atômicas, idempotência, cursor pós-confirmação, cancelamento parcial, reinício e isolamento. Registros sintéticos removidos e serviço devolvido parado, sem alterar dados/volumes existentes. UI sintética salvou a opção e manteve-a após recarregar.
- Sem nova chamada OpenAI ou envio WhatsApp nesta implementação. Commit/push/deploy/publicação aguardam aprovação após apresentação de 18 arquivos, versão e mensagem; equipe/MFA continua fora. Procedimento e limites em [CATALOGO_COMERCIAL.md](docs/CATALOGO_COMERCIAL.md).

## Seleção completa do catálogo e espera por empresa — 13/10/2026

- v1.16.0 (`ffcc557`) efetivamente publicada; roteiro da revisão 21 publicado como configuração 10 e reativação autorizada pelo painel gerou configuração 11. Catálogo saudável com três produtos. Evidência em `.tmp/DEPLOY_V1.16.0_20261013.md`.
- Teste real às 20:27 UTC: uma imagem e um texto gerados pela IA foram entregues/lidos. Não foi falha de transporte: o checkpoint continha apenas esses dois blocos, embora o cliente tivesse pedido os três modelos e o texto prometesse apresentá-los. Espera observada entre geração e envio: cerca de 35 segundos.
- Candidata v1.17.0 completa seleção parcial quando a mensagem pede explicitamente dois/três/todos os modelos sem filtros. Mantém IDs permitidos, disponibilidade, unidades, limite de três e perguntas prévias quando a IA ainda não oferece produtos; modelos específicos, exclusões e filtros permanecem sob seleção contextual. O formato também orienta a IA a selecionar a quantidade prometida.
- Novo `ai.responseDelayEnabled` no onboarding: ausência mantém a espera atual; falso envia após geração sem aguardar 30–45 segundos, com checkpoint e revalidação mantidos. Prazo de lote já persistido não é alterado. Campo omitido em revisões antigas preserva a compatibilidade de checksum; nenhuma migração/dependência nova.
- Validação Node 22 da candidata isolada: 503 casos, 485 aprovados, 18 skips opt-in, zero falhas. Novos casos exercitam o pedido real, unidade/filtros, seleção inválida, espera desativada, isolamento, bloqueio durante geração e retomada de envio parcial. Interface sintética salvou a opção falsa e manteve-a após recarregar. Não houve chamada OpenAI/WhatsApp nesta correção nem nova execução PostgreSQL/Redis; as operações de persistência não foram alteradas.
- Fechamento: commit `e50747c`/v1.17.0 enviado a dev e publicado na VPS com autorização; backup verificado e cópia externa cifrada preservados. ALFATECH publicada pelo painel na configuração 12, ativa e sem espera. Teste real da conversa confirmada: STARMEGA X900, YALA YBH-10 e HARLEY enviados como imagens com legendas individuais, todos entregues/lidos; primeira foto após 5,525 s. Evidência em `.tmp/DEPLOY_V1.17.0_20261013.md`. Outras empresas, proteção humana e trabalho de equipe/MFA preservados.

## Catálogo em mensagens com imagem — 13/10/2026

- Base v1.15.1 (`7d82895`) publicada e vínculo real confirmado; posteriormente, valores `1000W`/`50km` impediam importar os três produtos. Seis células corrigidas pelo navegador para números e sincronização recuperada: catálogo saudável com três fichas no runtime configVersion 9. Empresa já ativa na conferência posterior; não foi reativada pela intervenção. Evidências `.tmp/DEPLOY_V1.15.1_20261013.md` e `.tmp/ALFATECH_SHEETS_RECUPERADO_20261013.md`.
- Novo pedido implementado localmente como v1.16.0: um produto por mensagem, foto da ficha e legenda determinística, seleção da IA por IDs permitidos, suporte Meta/YCloud. Mantém catálogo legado textual, agenda, condições comerciais e grupos fora deste escopo.
- Checkpoint existente passa a gravar cada bloco/status individual em uma transação, sem migração; envio em ordem, revalidação por bloco e retomada dos não confirmados. Guarda a espera da IA e cancela blocos pendentes quando o bot perde autorização. Rollback exige concluir/cancelar lotes antes de voltar à versão antiga.
- Candidata isolada Node 22: 495 casos, 477 aprovados, 18 skips, zero falhas. PostgreSQL real em `waia-test` passou checkpoint/lote/isolamento/cancelamento; volumes e dados anteriores preservados e serviço devolvido ao estado parado. Fotos atuais verificadas por metadados HEAD somente; nenhum envio WhatsApp/OpenAI real. Resposta inválida preserva consumo informado pelo provedor; aceitação sem ID impede retry automático do lote.
- Roteiro atualizado pelo painel no rascunho. Arquivos, mensagem aprovada e limites em [CATALOGO_MENSAGENS.md](docs/CATALOGO_MENSAGENS.md). Usuário autorizou explicitamente commit, push de dev, deploy e publicação do roteiro; execução em andamento. Evidência final será registrada em `.tmp/DEPLOY_V1.16.0_20261013.md`. Trabalho anterior de equipe/MFA preservado e fora da candidata.

## Catálogo Google Sheets — 13/10/2026

- v1.15.0 (`4c9e8ad`) enviada a dev e publicada na VPS após autorização, com backup cifrado e smoke aprovados; detalhes em `.tmp/DEPLOY_V1.15.0_20261013.md`. Conta de serviço dedicada sem papéis de projeto, JSON cadastrado pelo usuário e acesso Leitor à planilha confirmados. Preflight 3/3 aprovado; roteiro/vínculo publicados como configVersion 7.
- A conferência somente leitura do runtime revelou que o editor gera IDs lógicos, mas o novo loader exigia referência física. Correção v1.15.1 preparada para resolver vínculo lógico por tipo quando há uma única conexão ativa no mesmo tenant, sem fallback para UUID concreto incorreto ou conexão ambígua. Candidata isolada Node 22: 482 casos, 464 aprovados, 18 skips, zero falhas; consulta SQL exercitada somente em leitura, sem conteúdo de células/credenciais em saída. Commit, push de dev e deploy explicitamente autorizados em 13/10/2026; execução em andamento.
- ALFATECH encontrada suspensa: sincronização automática não ocorre enquanto estiver assim. Sincronização manual funciona; catálogo ainda vazio. O usuário decidiu manter a empresa suspensa. Não declarar a ligação no contexto da IA concluída antes de publicar/verificar a v1.15.1. Evidência final desta operação será registrada em `.tmp/DEPLOY_V1.15.1_20261013.md`.

- Candidata v1.15.0 preparada para importar fichas de produtos A:L e disponibilizá-las ao atendimento, preservando a agenda anterior e sem migração/dependência nova. Conta de serviço Leitor, limite de 100 produtos ativos, validação sanitizada e catálogo indisponível em falha/cache antigo. Fotos fornecidas como links; anexos e grupo interno não foram implementados.
- Planilha ALFATECH estruturada com Produtos/Instruções, filtros, congelamento e listas; nenhum modelo inventado. Exportação conferida e duas abas revisadas visualmente. Bloco de catálogo adicionado pelo painel ao roteiro da ALFATECH e salvo no rascunho; ainda não publicado.
- Google Cloud liberado pelo usuário, que indicou samuelfelipeleao@gmail.com como a conta a utilizar; projeto existente waia-production disponível. Criação da conta de serviço/JSON, compartilhamento Leitor, importação real e vínculo publicado continuam pendentes. Não há comprovação de Google/WhatsApp real para produtos.
- Dez testes específicos e formulário com API sintética aprovados. Checkout completo: 485 casos, 466 aprovados, 19 skips opt-in, zero falhas. Candidata isolada em Node 22 sem rede: 481 casos, 463 aprovados, 18 skips opt-in, zero falhas. `git diff --check` aprovado. PostgreSQL/Redis opt-in não executados nesta alteração. Alterações anteriores de equipe/MFA preservadas e excluídas da candidata; `panel/app.js` exige seleção parcial. Detalhes/arquivos/mensagem de commit em [CATALOGO_GOOGLE_SHEETS.md](docs/CATALOGO_GOOGLE_SHEETS.md). Usuário autorizou explicitamente commit, push de dev e deploy da v1.15.0 em 13/10/2026 após revisão; execução em andamento, sem promoção de main.

## Espera das respostas de IA — 11/10/2026

- Base atual: `84f13d9`, v1.14.1, commit/push e deploy concluídos com autorização anterior; evidência operacional local em `.tmp/DEPLOY_V1.14.1_20261011.md`. Os registros de preparação abaixo são históricos.
- Novo pedido implementado localmente como v1.14.2: uma resposta bem-sucedida da IA recebe prazo aleatório de 30–45 segundos após a geração. Resposta/prazo ficam no checkpoint existente; PostgreSQL/BullMQ adiam o mesmo job, liberando slots/locks durante a espera e preservando a ordem por conversa. Reentrada reutiliza resposta e prazo, sem chamar novamente a IA por causa da espera. Respostas determinísticas, contingência e envio humano mantêm o comportamento anterior.
- Antes do envio agendado, verifica conversa aberta/em modo bot, contato disponível e número ativo; pausa/assunção/bloqueio cancelam a resposta pendente. Exclusão conclui o job e impede reenvio. Prazo corrompido ou lease perdido impedem o envio. Sem migração ou configuração por tenant/segredo nesta entrega.
- Candidata isolada, sem F2: Node 22, 471 casos, 453 aprovados, 18 skips opt-in, zero falhas. Dois testes adicionais com PostgreSQL 16/Redis reais aprovados: persistência/adiamento/revalidação, ordem por conversa e outra conversa avançando durante a espera, sem consumir tentativas de falha. Banco temporário e fila sintética removidos; banco/filas/volumes existentes de `waia-test` preservados e PostgreSQL/Redis devolvidos ao estado parado.
- Checkout completo com alterações anteriores preservadas: Node 24, 475 casos, 456 aprovados, 19 skips opt-in, zero falhas. Whitespace e versões 1.14.2 conferidos.
- Sem envio WhatsApp real ou chamada à IA nesta validação. Após apresentação, commit, push de dev e deploy da v1.14.2 explicitamente aprovados em 11/10/2026; execução em andamento, com backup e rollback para v1.14.1. Alterações anteriores de equipe/MFA preservadas. Arquivos, mensagem proposta e limites em [ESPERA_RESPOSTAS_IA.md](docs/ESPERA_RESPOSTAS_IA.md).

## Contatos e reinício do atendimento — 11/10/2026

- Pedido específico implementado localmente em `dev`, sobre HEAD `2b7ce50`: candidata v1.14.1. Colunas Contato/Número e detalhes da conversa mostram nome (padrão `none`) e telefone real do cliente; edição de nome e exclusão disponíveis a administradores nas telas Contatos e Conversas e mensagens.
- Exclusão auditada e transacional aposenta o contato, arquiva todas as suas conversas na empresa, apaga texto/payload das mensagens e limpa estado/cooldown. Cancela jobs pendentes de IA/envio humano e recusa exclusão enquanto algum deles estiver em processamento. Próximo webhook inédito usa novo contato/conversa, sem reaproveitar histórico. Identificadores de mensagens preservam deduplicação; pedidos, agendamentos, consumo, auditoria e mídia sob retenção preservam referências. Não é expurgo de todos os registros nem exclusão no WhatsApp do cliente.
- Candidata isolada de HEAD + somente este escopo, excluindo equipe/MFA: Node 24, 462 casos, 446 aprovados, 16 skips opt-in, zero falhas. Checkout completo também passou a suíte antes dos últimos ajustes de apresentação/fila; evidência principal é a candidata final. Navegador Chrome, API em memória e dados sintéticos: editar nome, número/detalhe, cancelar/Escape, conflito, exclusão, lista vazia e novo contato conferidos em desktop/mobile; 390px sem overflow ou erro JS. Corrigidos estado vazio apagado pelo carregamento e valor antigo do diálogo de confirmação.
- Após apresentação, usuário definiu versão 1.14.1 pelo tamanho da alteração e aprovou commit, push e deploy. Docker disponível na rodada de publicação: candidata isolada Node 22 com 462 casos, 446 aprovados, 16 skips, zero falhas. PostgreSQL 16 de `waia-test`, banco temporário isolado: teste opt-in de exclusão/409, isolamento, deduplicação e próximo webhook aprovado com role da aplicação; transação revertida e banco temporário removido. Banco/volumes existentes preservados. Redis e concorrência com workers ativos não exercitados; sem chamada real à IA/WhatsApp.
- Commit/push/publicação autorizados e em andamento, sem migração nova ou mudança de tenant real. Alterações anteriores de F2 preservadas; `panel/app.js` exige seleção parcial. Detalhes em [CONTATOS_PAINEL.md](docs/CONTATOS_PAINEL.md).

## Roteiro único da IA — 08/10/2026

- Pedido específico implementado localmente em `dev`, sobre HEAD `696bfbe`: v1.14.0. Campo único do contrato existente `ai.prompt`, visível em Módulos e configurações / Identidade e atendimento e na etapa Atendimento do onboarding. Editor ampliado ocupa a tela, mantém o texto ao fechar/Escape e protege edições contra atualização automática, navegação e troca de empresa.
- Saudações, menu, aliases e respostas públicas passam antes da IA. Com roteiro preenchido e IA habilitada, texto sem predefinição usa IA mesmo quando o fallback anterior não a selecionava. Cada requisição recebe o roteiro integral, acima do estilo complementar e do histórico, respeitando regras da plataforma. Pergunta complementar automática desativada nesse caso. Pausa humana, cooldown e continuações transacionais preservados.
- O painel salva o rascunho V2 com revisão otimista; a aplicação ao runtime exige revisão/publicação pelo onboarding. Sem rascunho, mantém a API legada e passa a aceitar roteiro multilinha de até 20000 caracteres. Nenhuma migração, credencial, configuração de empresa real ou chamada externa nesta alteração.
- Checkout completo em Node 24: 457 casos, 441 aprovados, 16 skips opt-in, zero falhas. Candidata isolada de HEAD + somente esta atualização, sem F2/equipe/MFA, em Node 22 no Docker sem rede: 453 casos, 438 aprovados, 15 skips opt-in, zero falhas. `git diff --check` aprovado. Navegador com API sintética: carregamento do roteiro V2, tela cheia, Escape, preservação do texto, proteção de descarte, salvamento e recarga conferidos; diálogo medido em 1280 × 720, sem overflow interno.
- Alterações anteriores de equipe/MFA preservadas e excluídas da candidata; `panel/app.js` contém hunks dos dois trabalhos e exige seleção parcial no commit. Arquivos, limitações e mensagem proposta em [ROTEIRO_ATENDIMENTO.md](docs/ROTEIRO_ATENDIMENTO.md). Usuário autorizou explicitamente commit, push e deploy na VPS em 08/10/2026, após apresentação do conjunto; execução em andamento. Testes locais não comprovam PostgreSQL/Redis opt-in, atendimento real no WhatsApp ou aderência de respostas reais da IA.

## Retomada após encaminhamento — 07/10/2026

- Pedido específico: o mesmo lead deve voltar ao atendimento normal ao enviar mensagem após o encaminhamento; prazo de teste de 60 segundos, posteriormente configurável em horas.
- Preparada v1.13.0: `humanHandoff.cooldownSeconds` configurável pelo onboarding, de 0 a 604800 segundos; 0 preserva a pausa manual anterior. O prazo fica no estado persistido da conversa e não reinicia a cada mensagem. Na espera, o worker não prepara/envia resposta; vencido o prazo, processa a mensagem atual pelo roteiro normal. Não envia mensagem espontânea ao vencer.
- Handoff temporizado mantém o modo bot com estado `waiting_operator`; pausas manuais e modo humano continuam bloqueados pelo worker. Estado antigo em modo bot usa o instante persistido da espera; modo pausado antigo requer retomada manual pelo painel para não desfazer decisões de operadores.
- Escopo geral compatível, sem código especial por cliente, migração ou segredo. Configuração de 60 segundos da Filaretti será feita pelo painel após publicação desta capacidade. Alterações anteriores de F2 preservadas e excluídas da candidata.
- Testes específicos e regressão de configuração/runtime: 24 aprovados, sem falhas. Candidata de HEAD `d24735e` + somente os 12 arquivos desta alteração, sem F2: suíte completa no host e em Node 22 no Docker; Node 22 com 448 casos, 433 aprovados, 15 skips opt-in, zero falhas. `git diff --check` aprovado. Testes usam relógio controlado/adapters sintéticos; PostgreSQL/Redis opt-in e WhatsApp real não executados nesta mudança. Commit/push e deploy ainda dependem das autorizações próprias do projeto.
- Contexto anterior confirmado na conversa: v1.12.2 publicada e integração/coexistência confirmadas pelo usuário; roteiro da Filaretti revisão 36 publicado pelo painel. Os registros abaixo sobre pendências de v1.12.2 descrevem etapas anteriores.

## Estado mais recente — YCloud, 07/10/2026

- Deploy autorizado de v1.12.1 (`b780ae9`) concluído, sem promoção de main. Imagem `waia:1.12.1-b780ae9` idêntica na estação/VPS; API/worker saudáveis, readiness 200; migrações 021/022/024, contas públicas desligadas e F2/023 excluídas. Release anterior e imagem preservadas para rollback.
- Backup de banco/mídia/manifesto verificado antes do deploy. Drive recusou OAuth (`invalid_grant`); alternativa AES-256-GCM copiada e autenticada na estação, com chave protegida separadamente. Renovação do Drive pendente. Evidência detalhada local: `.tmp/DEPLOY_V1.12.1_20261007.md`.
- Assets do onboarding foram publicados com nomes que incluem o commit para contornar cache antigo do navegador; transformação somente de empacotamento, sem mudança de lógica. Automatizar/preservar esse procedimento em releases futuras.
- Filaretti permanece em rascunho. API key e assinatura salvas no cofre pelo painel; teste de saúde real aprovou a conexão YCloud. Endpoint externo ativo para entrada/status. Número continua pendente/secundário: ativação pelo painel foi recusada pela exigência antiga de token Meta.
- Correção local v1.12.2: ativação aceita a API key YCloud vinculada ao próprio número/empresa e conexão ativa; preserva o caminho Meta. Não configura clientes por SQL nem duplica credenciais Meta. Commit/push/publicação da correção aguardam aprovação.
- Validação em snapshot de HEAD + correção, sem F2: suíte Node 22 concluída sem falhas (443 casos, 15 skips opt-in); testes Meta/YCloud em PostgreSQL 16 real: 2 aprovados, incluindo ativação, chave revogada e conexão pendente mesmo com token Meta genérico presente. Banco temporário isolado removido e PostgreSQL de waia-test devolvido ao estado parado. Falhas iniciais do harness (prontidão/permissões e fixture de revogação) corrigidas antes do resultado final.
- Recebimento/envio de mensagem real e uso simultâneo no celular ainda não testados; IA/FAQ e publicação da empresa continuam pendentes.

Os registros de preparação abaixo descrevem etapas anteriores ao deploy concluído acima.

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
