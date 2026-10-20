# Plano ativo — WAIA 2.0.0

Atualizado em 20/10/2026. Especificação completa: [WAIA_2.0.0.md](WAIA_2.0.0.md).
Estado e histórico resumido: [RELATORIO.md](RELATORIO.md).

Pedido de 20/10/2026: simplificar ALFATECH para nome, cidade e modelo de interesse de novo comprador, aproveitando o nome no anúncio e desconectando planilha/catálogo do atendimento. Pós-venda/manutenção/outros assuntos devem seguir ao humano sem ficha/notificação. Candidata local v1.22.0 opt-in por empresa: 575 testes aprovados/20 skips em Node 22 e 15 verificações PostgreSQL reais aprovadas; roteiro/escopo/limites em [TRIAGEM_COMERCIAL.md](docs/TRIAGEM_COMERCIAL.md). Rascunho 69 preparado pelo painel, sem publicação; novo modo e desabilitação operacional do conector serão concluídos após deploy aprovado. Empresa observada suspensa, sem reativação. Equipe/MFA preservados; commit/push/deploy/publicação dependem de aprovação específica.

Continuação de 20/10/2026: teste após v1.21.3 gerou ficha ALFATECH, encerramento lido e pausa às 16h45; notificação ficou pendente sem tentativa. Remetente conectado, mas descoberta/cache de grupos sem atualização desde inicialização e falhas genéricas repetidas. Candidata v1.21.4 isola descoberta da entrega: falha na listagem não bloqueia destino configurado, ainda revalidado individualmente; intervalo de consulta e logs por etapa/código sanitizados. Entradas de grupo inválidas/duplicadas são descartadas. Escopo em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit 3520aa9 enviado a dev e v1.21.4 publicada com autorização; serviços saudáveis e configurações preservadas. O lead pendente já havia sido aceito pelo conector às 16h48, antes da publicação; mesma ficha/entrega preservada sem duplicação. Usuário confirmou recebimento do resumo no grupo teste; ficha, pausa, destino e registro único conferidos. Falha intermitente de descoberta GROUPS_UNAVAILABLE observada após deploy, agora isolada da fila. Evidência final local em `.tmp/DEPLOY_V1.21.4_20261020.md`. Equipe/MFA e configurações preservados.

Correção de 20/10/2026: teste ALFATECH na v1.21.2/configuração 29 enviou encerramento comum às 16h27, sem ficha estruturada, pausa ou pendência para grupo; não houve tentativa de entrega. Grupo teste/remetente saudáveis. Candidata v1.21.3 detecta promessa de conclusão sem ficha e reavalia uma única vez com histórico original e critérios publicados. Conclusão exige ficha válida; repetição da promessa volta à coleta, sem inventar lead. Duas chamadas possíveis previamente reservadas na quota, consumo real agregado e mesmo prazo total. Escopo/limites em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit 882aad6 enviado a dev e v1.21.3 publicada com autorização; serviços saudáveis, remetente conectado e configuração 29/grupo da ALFATECH preservados. Teste real de entrega solicitado, ainda pendente. Evidência final local em `.tmp/DEPLOY_V1.21.3_20261020.md`. Equipe/MFA e configurações de clientes preservados.

Correção de 19/10/2026: configuração de leads da ALFATECH publicada pelo painel na versão 27; grupo `teste` habilitado e remetente conectado. Novo teste não gerou ficha/outbox: resposta OpenAI às 15h42 retornou `AI_INVALID_CATALOG_SELECTION` durante coleta, sem erro de transporte do grupo. Candidata local v1.21.2 preserva a resposta conversacional com referência válida ao produto durante coleta e impede encerramento isolado por produto em empresas com triagem. IDs/filtros inválidos continuam bloqueados; catálogo e conclusão pela ficha preservados. Versão 28 atualmente ativa preservada (alteração posterior de contingência pelo painel). Testes e escopo em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit 12aae3b enviado a dev e v1.21.2 publicada com autorização; serviços saudáveis, remetente conectado e configuração 28/grupo da ALFATECH preservados. Teste real de entrega solicitado ao usuário, ainda pendente. Evidência final local em `.tmp/DEPLOY_V1.21.2_20261019.md`; equipe/MFA fora do escopo. Sem reset ou reenvio antigo.

Correção de 18/10/2026: diagnóstico real da Filaretti às 23h02 confirmou `AI_INVALID_LEAD_QUALIFICATION` após resposta OpenAI (111/400 tokens), não timeout. Candidata local v1.21.1 trata ficha parcial como coleta, preserva conclusão válida sem texto redundante e continua com pergunta quando a ficha inválida não pode ser enviada. Roteiro feminino/sem recapitulações publicado pelo painel como configuração 12, rascunho 57, preservando modelo, limites e grupo. Escopo, evidência e validações em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit, push de dev e deploy da v1.21.1 explicitamente autorizados após revisão dos oito arquivos e testes; execução em andamento. Evidência final local em `.tmp/DEPLOY_V1.21.1_20261018.md`. Equipe/MFA preservados. Não reenvia nem reinicia o atendimento do print.

Autorização de 18/10/2026: usuário aprovou commit `feat: v1.21.0 notificações de leads por empresa` e push de dev, após revisão dos 41 arquivos e validações. Execução em andamento; registro final em `.tmp/COMMIT_V1.21.0_20261018.md`. Publicação em produção e promoção de main continuam pendentes de autorização própria.

Continuação autorizada em 18/10/2026: candidata local v1.21.0 integra triagem estruturada, ficha/outbox atômicos, remetente central com sessão cifrada/lease exclusivo, destino por empresa e acompanhamento no painel. Critério Filaretti aprovado: nome, relato suficiente e área atendida, para análise humana. Candidata isolada Node 22: 537 aprovados/20 skips; PostgreSQL real: 11 casos aprovados em banco temporário exclusivo de waia-test, removido e serviço devolvido parado. Piloto QR funcionou conforme confirmação do usuário; fluxo persistente ainda sem teste externo/publicação. Equipe/MFA fora da candidata. Arquivos/operação em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit/push/deploy pendentes de autorização específica; não conclui F5.

Correção de encerramento em 14/10/2026: v1.19.1 publicada, baseada na release v1.19.0 / c68f774. Diagnóstico real encontrou três falhas AI_INVALID_CATALOG_SELECTION ao receber escolhas de produto. Encerramento da IA passa a normalizar texto/filtros irrelevantes, preservando IDs e mensagem aprovada. Escolha simples por nome ou ficha citada usa fechamento determinístico, sem chamada OpenAI, com checkpoint, revalidação e pausa pós-confirmação. Contexto de resposta do WhatsApp persistido e isolado. Node 22: 536 casos, 517 aprovados, 19 skips, zero falhas; dois testes PostgreSQL reais aprovados, fixtures próprias removidas e waia-test devolvido parado. Sem envio WhatsApp/OpenAI disparado pela automação durante a preparação ou reset. Commit 6f62fb1 autorizado/enviado a dev e v1.19.1 publicada; ALFATECH ativa na configuração 24 preservada. Teste real em 14/10/2026 às 18:16:55 (America/Sao_Paulo): resposta à foto identificou HARLEY; encerramento configurado confirmado pelo provedor e lido; interesse registrado em nota interna e checkpoint concluído; conversa pausada, sem foto repetida. Conferência somente em leitura, sem reset ou retomada do bot. Evidência: `.tmp/DEPLOY_V1.19.1_20261014.md`. Registro final local, sem segundo commit. Piloto 1.20 e equipe/MFA preservados fora da candidata. Detalhes em [ANUNCIOS_CATALOGO.md](docs/ANUNCIOS_CATALOGO.md).

Pedido específico de 14/10/2026: preparada candidata local v1.20.0 para testar um remetente WAIA dedicado por QR e notificar grupos separados por empresa. Console só em loopback, sessão volátil e mensagens fictícias; sem integração de leads reais/produção. O titular ainda precisa ativar o número no aplicativo. Dez testes específicos aprovados em Node 24/22, suíte completa local com código 0 e auditoria sem vulnerabilidades reportadas. Escopo, operação e próxima entrega em [NOTIFICACOES_GRUPOS.md](docs/NOTIFICACOES_GRUPOS.md). Commit/push/deploy não executados nem autorizados nesta entrega; não conclui F5.

Pedido de 14/10/2026: preparada candidata v1.19.0 sobre v1.18.2 / `d255ec8` efetivamente publicada. Preserva contexto de anúncios do Facebook/Instagram que levam ao WhatsApp, identifica nome inequívoco na planilha e oferece encerramento comercial configurável com registro interno/pausa após confirmação de envio. Não atende Direct nem envia ao grupo. Roteiro salvo no rascunho 32. Node 22: 512 testes aprovados/19 skips; PostgreSQL real: dois testes aprovados. Usuário autorizou explicitamente commit/push/deploy/configuração/publicação e determinou suspender ALFATECH; execução em andamento. Evidência final será registrada em `.tmp/DEPLOY_V1.19.0_20261014.md`. Escopo e limites em [ANUNCIOS_CATALOGO.md](docs/ANUNCIOS_CATALOGO.md).

Correção de 14/10/2026: preparada v1.18.2 sobre v1.18.1 / `c94edde` publicada. Novo pedido explícito de catálogo/faixa de preço começa pelos três primeiros elegíveis; "mais opções" usa somente o cursor da consulta atual; manifestação de interesse preserva o bloqueio de reenvio. Histórico global de apresentações separado do avanço da página. Sem reset de contato ou alteração de produtos. Roteiro salvo no rascunho 31 da ALFATECH; candidata isolada Node 22 com 501 testes aprovados/18 skips e PostgreSQL real aprovado. Commit/push/deploy e publicação do roteiro explicitamente autorizados após apresentação dos 10 arquivos e validações; execução em andamento. Detalhes em [CATALOGO_COMERCIAL.md](docs/CATALOGO_COMERCIAL.md).

Correção de 13/10/2026: candidata v1.18.1 evita reapresentar fichas já confirmadas na mesma conversa, inclusive quando a IA interpreta "gostei da Harley" como pedido de produto ou muda os filtros. Consulta persistida recupera os IDs de todas as apresentações confirmadas, com isolamento por empresa/conversa; falhas e cancelamentos continuam elegíveis para nova tentativa. Saudação, menu e roteiro da ALFATECH corrigidos e publicados pelo painel na configuração 17, preservando botão humano e espera desativada. Candidata isolada: 499 testes aprovados, 18 skips e PostgreSQL real aprovado. Commit/push/deploy do bloqueio explicitamente autorizados após apresentação dos 10 arquivos; execução em andamento. Detalhes em [CATALOGO_COMERCIAL.md](docs/CATALOGO_COMERCIAL.md).

Atendimento comercial em 13/10/2026: pedido específico preparado como v1.18.0. Roteiro/saudação/menu da ALFATECH salvos no rascunho: modelo primeiro, cidade no encaminhamento, fichas diretas e resposta técnica contextual. Nova opção por empresa apresenta abertura, até três fichas na ordem da planilha e pergunta final; páginas seguintes mantêm filtros e avançam somente por envios confirmados. Escopo/testes em [CATALOGO_COMERCIAL.md](docs/CATALOGO_COMERCIAL.md). Commit/push/deploy aguardam autorização específica; não inicia outras fases.

Correção e controle de testes em 13/10/2026: v1.17.0 (`e50747c`) commitada/enviada a dev e publicada com autorização. ALFATECH ativa na configuração 12, espera desativada pelo painel e três fotos/legendas efetivamente entregues/lidas no teste real (primeira em 5,525 s após entrada). Detalhes em `.tmp/DEPLOY_V1.17.0_20261013.md`. Escopo de 16 arquivos e validações em [CATALOGO_MENSAGENS.md](docs/CATALOGO_MENSAGENS.md); nenhuma promoção de main.

Adendo de 13/10/2026: pedido de mensagens individuais do catálogo preparado como v1.16.0. Cada produto com foto usa imagem e legenda com fatos validados; seleção da IA por IDs, persistência/status por bloco e retomada sem repetir envios confirmados. Roteiro da ALFATECH salvo no rascunho. Arquivos, validações e limites em [CATALOGO_MENSAGENS.md](docs/CATALOGO_MENSAGENS.md). Commit, push de dev, deploy e publicação do roteiro explicitamente autorizados; execução em andamento. Não estende a fase autorizada para outras pendências.

Correção de 13/10/2026: v1.15.0 publicada como `4c9e8ad`; a conferência real do runtime identificou incompatibilidade com IDs lógicos gerados pelo painel. Correção compatível preparada como v1.15.1, mantendo o isolamento por empresa e recusando conexões ambíguas. Escopo/testes em [CATALOGO_GOOGLE_SHEETS.md](docs/CATALOGO_GOOGLE_SHEETS.md). Commit, push de dev e deploy explicitamente autorizados; execução em andamento. O usuário decidiu manter a ALFATECH suspensa.

Adendo de 13/10/2026: catálogo de produtos por Google Sheets preparado como candidata v1.15.0, por pedido específico da ALFATECH. Preserva o perfil de agenda e prepara fichas/valores/unidades/links de fotos para o contexto da IA; roteiro salvo no rascunho e planilha estruturada. Conta de serviço, vínculo real e publicação ainda pendentes. Escopo, limites e arquivos em [CATALOGO_GOOGLE_SHEETS.md](docs/CATALOGO_GOOGLE_SHEETS.md). Commit/push e deploy explicitamente autorizados após revisão em 13/10/2026; execução em andamento. Não conclui a F7.

Adendo de 11/10/2026: espera das respostas de IA preparada como v1.14.2, sobre v1.14.1/`84f13d9` já publicada. Após uma resposta bem-sucedida da IA, aguarda intervalo aleatório de 30–45 segundos antes do envio, com prazo persistido e revalidação da conversa. Escopo e evidência em [ESPERA_RESPOSTAS_IA.md](docs/ESPERA_RESPOSTAS_IA.md). Commit, push e deploy explicitamente aprovados após apresentação; execução em andamento. Não conclui a F6.

Adendo de 11/10/2026: pedido específico de contatos no painel preparado como v1.14.1, versão definida pelo usuário pelo tamanho da alteração. Conversas exibem nome (padrão `none`) e telefone real do cliente; administradores podem editar o nome e excluir o contato para reiniciar o atendimento. Escopo, arquivos, validações e limites em [CONTATOS_PAINEL.md](docs/CONTATOS_PAINEL.md). Commit, push e deploy explicitamente aprovados após apresentação; execução em andamento. Não conclui a F6.

Adendo de 08/10/2026: roteiro único da IA preparado localmente como v1.14.0, por pedido específico, em Módulos e configurações / Identidade e atendimento, com editor em tela cheia. Predefinições continuam determinísticas; mensagens livres recebem o roteiro completo em cada chamada. Publicação versionada, pausas humanas e fluxos operacionais preservados. Escopo, arquivos e evidência em [ROTEIRO_ATENDIMENTO.md](docs/ROTEIRO_ATENDIMENTO.md). Commit/push e deploy na VPS explicitamente autorizados em 08/10/2026, após apresentação do conjunto; execução em andamento. Não conclui a F3 do SaaS.

Adendo de 07/10/2026: conector YCloud da Filaretti publicado em produção como v1.12.1 (`b780ae9`), com autorização explícita. Conexão validada pelo painel e webhook ativo na YCloud. A ativação do número encontrou validação administrativa ainda exclusiva da Meta; correção preparada como v1.12.2, aguardando aprovação de commit/push e publicação. Escopo e gates em [YCLOUD_FILARETTI.md](docs/YCLOUD_FILARETTI.md). Não conclui nem autoriza o restante da F5.

Deploy de 07/10/2026: imagem v1.12.1 imutável validada em Node 22, com zero vulnerabilidades; migrações 021/022/024 aplicadas, sem F2/023. Serviços saudáveis e rollback preservado. Backup verificado e cópia cifrada na estação; renovação OAuth do backup Google Drive pendente. Evidência operacional em RELATORIO.md.

## Objetivo

Evoluir a base atual para SaaS de autoatendimento: conta individual, empresa própria, assinatura, configuração da IA, conexão WhatsApp guiada e inbox com controle humano/automático.

## Estado e autorização

- `main`: referência estável v1.10.6, merge `707a46d`, promovida com autorização em 16/09/2026.
- `dev`: F0 versionada/publicada no commit `40eeb9c` (v1.10.9); F1 preparada como v1.11.0, com commit/push explicitamente autorizados pelo usuário.
- Produto 2.0.0 permanece futuro; a F1 é uma entrega incremental compatível.
- Pedido de início recebido em 16/09/2026: iniciada F0, preservando a revisão documental anterior.
- F0 concluída e commit/push autorizados. F1 autorizada posteriormente e implementada; gate local validado em PostgreSQL/Redis reais. Commit/push da F1 autorizados após apresentação do conjunto; F2 aguarda autorização própria.

## Sequência de execução

| Fase | Entrega | Gate principal | Estado |
|---|---|---|---|
| F0 | Baseline, inventário e decisões | Ambiente/testes conhecidos; contratos definidos | Concluída; commit 40eeb9c |
| F1 | Conta e empresa do cliente | Dois cadastros independentes com isolamento real | Gate local concluído; commit/push autorizados; e-mail real pendente |
| F2 | Equipe, propriedade, MFA e permissões | Sem escalada de acesso; revogação efetiva | Planejada |
| F3 | Questionário e IA simplificados | Configuração/publicação sem intervenção técnica | Planejada |
| F4 | Planos, assinatura e quotas | Sandbox completo, idempotência e reconciliação | Planejada |
| F5 | WhatsApp guiado | Conector/QR aprovado e duas conexões isoladas | Planejada |
| F6 | Inbox e automação | Humano/IA/pausa seguros sob concorrência | Planejada |
| F7 | Conhecimento por empresa | PDF/texto/URL isolados e removíveis | Planejada |
| F8 | Site e prontidão comercial | Jornada completa, termos e operação aprovados | Planejada |
| F9 | Candidata e piloto | Restore/rollback, sete dias e aceite de release | Planejada |

Detalhes, dependências, arquivos, APIs, migrações, decisões e testes: seções 5–20 da especificação. Decisões técnicas F0: [ADR 001](docs/ADR_001_PORTAL_IDENTIDADE.md). Cada fase termina com relatório curto e evidência; não repetir aqui a especificação.

## Regras de continuidade

- Trabalhar no checkout principal e `dev`; preservar alterações do usuário e tenants existentes.
- Usar `waia-test` nas validações Docker, sem apagar volumes nem criar ambiente permanente por fase.
- Não editar migrações aplicadas; ampliar de modo aditivo e testar compatibilidade.
- Não exigir `.env`, seed, SQL, reinício ou deploy para cadastrar cada cliente.
- Antes de commit: arquivos, validações, versão e mensagem; confirmação explícita. Após confirmação, commit/push em `dev`; próxima fase exige novo aceite.
- Produção, domínio, fornecedor, credenciais reais, restauração e testes externos seguem autorização específica.
- `npm test` não comprova PostgreSQL/Redis opt-in nem capacidade da VPS.

## Decisões a fechar

E-mail/domínio, cobrança e preços, trial/limites, caminho Meta/QR, modelo e índice de conhecimento, proprietário/entitlement dos tenants legados, termos/retenção e metas de operação. Propostas e gates estão na seção 20 da especificação.
