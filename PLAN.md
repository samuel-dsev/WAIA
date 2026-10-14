# Plano ativo — WAIA 2.0.0

Atualizado em 14/10/2026. Especificação completa: [WAIA_2.0.0.md](WAIA_2.0.0.md).
Estado e histórico resumido: [RELATORIO.md](RELATORIO.md).

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
