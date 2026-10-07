# Plano ativo — WAIA 2.0.0

Atualizado em 18/09/2026. Especificação completa: [WAIA_2.0.0.md](WAIA_2.0.0.md).
Estado e histórico resumido: [RELATORIO.md](RELATORIO.md).

Adendo de 07/10/2026: conector YCloud solicitado para a Filaretti e preparado localmente como v1.12.0. Escopo e gates em [YCLOUD_FILARETTI.md](docs/YCLOUD_FILARETTI.md). Não conclui nem autoriza o restante da F5; commit/push autorizados em 07/10/2026, deploy pendente de autorização específica.

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
