# Preferências de colaboração do projeto

## Início de cada novo chat

- Leia este `AGENTS.md` antes de iniciar qualquer trabalho no projeto.
- Leia o `PLAN.md`, compare o estado real do código e do relatório com os gates planejados e trabalhe somente na fase atual já autorizada pelo usuário.
- Se nenhum relatório existir, informe isso ao usuário e não invente histórico. Crie-o somente quando houver contexto real do projeto para registrar ou quando o usuário solicitar.
- Durante a leitura, avalie se o relatório está excessivamente longo, redundante ou desatualizado. Se estiver, consolide o conteúdo e remova informações ultrapassadas, preservando apenas fatos, decisões, pendências e contexto ainda úteis.
- Estamos trabalhando atualmente em `implementações_finais.md`, continue com base nisso:
O que ainda falta no implementações_finais.md:202:

  1. Fechar os P0 externos da Fase 11:
      - Aprovar RPO/RTO.
      - Validar textos e responsável jurídico.
      - Definir VPN/allowlist administrativa.
      - Definir responsável por incidentes.
      - Configurar e testar um destino HTTPS real para alertas.
      - Formalizar a mitigação temporária de MFA/recuperação para o piloto.

  2. Fase 13 — infraestrutura de produção sem clientes:
      - VPS, firewall, DNS, TLS, volumes e logs.
      - Backup externo e custódia do keyring.
      - Monitoramento real.
      - Implantação exata da imagem v1.9.1-rc.1.
      - Smoke tests e rollback.

  3. Fase 14 — integrações externas reais:
      - Meta/WhatsApp real.
      - OpenAI com projeto e limites próprios.
      - Google Sheets controlado.
      - Webhook, mensagens, mídia, idempotência e revogação.

  4. Fase 15 — primeira empresa real pelo painel.
  5. Fase 16 — segunda empresa real e comprovação de isolamento.
  6. Fase 17 — abertura gradual e estabilização por pelo menos sete dias, seguida de autorização separada para main.


## Aprendizado de preferências

- Quando o usuário repetir de forma consistente um comando, uma preferência de fluxo ou um padrão de entrega, avalie se ele é reutilizável em chats futuros.
- Se for uma preferência estável e geral para este projeto, registre-a neste `AGENTS.md` de forma curta e inequívoca.
- Não registre pedidos pontuais, dados sensíveis, suposições ou hábitos inferidos a partir de um único caso ambíguo.
- Ao modificar este arquivo por uma nova preferência percebida, informe o usuário brevemente.

## Forma de trabalhar

- Antes de implementar mudanças, recupere o contexto disponível no repositório e preserve alterações existentes do usuário.
- Faça as implementações no checkout principal e na branch `dev`, sem criar worktree de desenvolvimento, salvo instrução posterior explícita do usuário.
- Nas validações Docker das próximas fases, reutilize o projeto Compose isolado `waia-test` e preserve todos os projetos Docker existentes; não crie um projeto permanente por fase nem remova ambientes sem autorização explícita.
- Para atualizações urgentes, priorize restaurar ou proteger o funcionamento atual e registre riscos ou débitos que devam ser tratados depois.
- Para futuras implementações, diferencie claramente o que já existe, o que é urgente, o que está planejado e o que ainda depende de decisão.
- Faça verificações proporcionais ao risco da alteração e relate com clareza o que foi alterado, o que foi validado e o que permanece pendente.
- Ao final de cada alteração, atualize a versão em `package.json` e `package-lock.json` de forma proporcional ao impacto: patch para correções compatíveis, minor para novas capacidades compatíveis e major somente para quebra deliberada de contrato.
- Antes de cada commit, apresente ao usuário os arquivos alterados, as validações, a nova versão e a mensagem descritiva, e aguarde confirmação explícita.
- Após a confirmação, faça o commit com a versão no título, envie a branch `dev` ao repositório remoto e só então peça nova confirmação para iniciar a próxima etapa do `PLAN.md`.
