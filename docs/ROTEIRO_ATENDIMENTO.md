# Roteiro único de atendimento — v1.14.0

Pedido de 08/10/2026, implementado localmente sobre `dev` / `696bfbe`. A mudança acrescenta a edição central do roteiro sem substituir as predefinições nem concluir a F3 do plano SaaS.

## Uso pelo painel

Em **Módulos e configurações / Identidade e atendimento**, o campo **Roteiro completo da IA** reúne tom, conduta, limites, dados da empresa e informações que precisam ser solicitadas ao contato. **Tela cheia** amplia a edição; **Voltar à configuração** ou Escape mantém o texto na caixa original. O limite é de 20000 caracteres. Não inserir credenciais: o roteiro é uma configuração da empresa enviada ao provedor de IA.

O campo reutiliza `ai.prompt`. Roteiros anteriores aparecem automaticamente; não existe uma segunda cópia de prompt. A mesma configuração pode ser editada na etapa **Atendimento** do onboarding, com seu autosave existente. Modelo, credencial, limites e estilo complementar continuam na etapa IA.

Empresas com rascunho V2 salvam com `PUT /configuration/draft` e `draftVersion`, preservando o restante da configuração. Depois de salvar, revisar e publicar pelo onboarding para aplicar ao atendimento. Conflito de edição não sobrescreve a outra revisão; o texto fica na tela para cópia/recuperação. A IA para texto livre precisa estar habilitada. Para empresas sem rascunho, o editor mantém `PATCH /ai-config/:empresaId` e salva somente `prompt` pela API legada.

## Atendimento

- Saudações, seleções do menu, aliases e respostas públicas configuradas são resolvidos antes da IA, sem chamada ao provedor.
- Com roteiro não vazio, `ai.enabled` e módulo `ai_freeform` ativos, mensagens sem predefinição são encaminhadas para `ai_freeform.reply`. Isso prevalece sobre o fallback anterior. IA desabilitada ou roteiro vazio preservam o roteamento anterior.
- Cada requisição à IA contém o roteiro inteiro no campo de instruções. O roteiro prevalece sobre personalidade/estilo complementar, histórico e instruções da mensagem recebida, permanecendo subordinado às regras da plataforma. Informações da empresa no roteiro também podem fundamentar a resposta.
- A pergunta complementar adicionada pelo runtime fica desativada quando há roteiro ativo: perguntas e conclusão devem ser definidas nele.
- Pausa/assunção humana, cooldown, quotas, proteção contra prompt injection e etapas transacionais de pedidos, agendamentos e fluxos continuam valendo. O roteiro não autoriza ações externas nem confirmações automáticas de pagamento.

O carregamento da configuração publicada continua separado do rascunho. Salvar o texto não publica silenciosamente todas as alterações pendentes da empresa. O simulador continua determinístico e não comprova a aderência linguística do modelo ao roteiro.

## Arquivos desta atualização

| Grupo | Arquivos |
|---|---|
| Painel | `panel/app.js` (somente hunks do roteiro), `panel/attendance-script.js`, `panel/onboarding.js`, `panel/styles.css` |
| API e contrato legado | `src/modules/admin/resources.js`, `src/modules/admin/admin-service.js` |
| Instruções da IA | `src/modules/ai/guardrails.js` |
| Configuração e roteamento | `src/modules/configuration/legacy-adapter.js`, `src/tenants/configured-runtime.js`, `src/tenants/postgres-config-loader.js` |
| Testes | `test/attendance-script.test.js`, `test/ai-multitenant.test.js` |
| Versão e continuidade | `package.json`, `package-lock.json`, `PLAN.md`, `RELATORIO.md`, este documento |

Sem migração ou dependência nova. Alterações preexistentes de equipe/MFA não integram esta candidata. `panel/app.js` é compartilhado com esse trabalho: não adicionar o arquivo inteiro ao commit sem separar seus hunks. Artefatos temporários em `.tmp/` não são parte da release.

## Validações e limites

- Suíte do checkout em Node 24: 457 casos, 441 aprovados, 16 skips opt-in, zero falhas.
- Candidata exclusiva desta atualização em Node 22 / Docker, sem rede: 453 casos, 438 aprovados, 15 skips opt-in, zero falhas. Snapshot de HEAD com os arquivos acima, removendo os hunks anteriores de equipe/MFA do painel. Log local: `.tmp/attendance-script-node22-tests.log`.
- Novos testes verificam predefinições sem IA, fallback pelo roteiro, pausa humana, ausência da pergunta antiga, instruções longas completas em chamadas consecutivas, atualização de configuração, persistência sem alteração das predefinições, validação multilinha, limite e isolamento administrativo.
- Navegador com dados/APIs sintéticos: roteiro do rascunho aparece em vez do prompt legado; expansão, edição, Escape, aviso de descarte, salvamento e recarga conferidos. Diálogo ocupa 1280 × 720, igual ao viewport, sem overflow interno. Prévia local: `.tmp/roteiro-tela-cheia.png`.
- `git diff --check` aprovado. Não foram executados PostgreSQL/Redis opt-in, chamadas pagas à OpenAI, mensagens reais de WhatsApp, configuração de tenant real ou deploy.

Mensagem proposta: **`v1.14.0 - adiciona roteiro único da IA com editor em tela cheia`**.

Commit, push de `dev` e deploy na VPS explicitamente autorizados pelo usuário em 08/10/2026 após revisão do conjunto; execução em andamento. Main permanece fora desta autorização. Ao empacotar o painel, incluir `attendance-script.js` e manter o procedimento existente de atualização dos assets/imports para evitar cache antigo.
