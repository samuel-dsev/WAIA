@C:\Users\Samuel\.codex\RTK.md

# Preferências de colaboração — WAIA

## Início e fonte de verdade

- Ler este arquivo, `PLAN.md` e `RELATORIO.md`; confirmar cwd/Git e comparar documentos com o código antes de implementar.
- O plano ativo é `WAIA_2.0.0.md`. `PLAN.md` é o índice de fases; `RELATORIO.md` contém estado e histórico resumido; `implementações_finais.md` é referência histórica.
- Trabalhar somente na fase autorizada. Planejamento não autoriza implementar todas as fases, contratar serviços ou publicar em produção.
- Se não houver relatório, informar e não inventar histórico; criar apenas com contexto real ou pedido do usuário.
- Consolidar relatórios longos preservando fatos úteis, decisões, riscos e pendências; não duplicar especificação em vários documentos.

## Forma de trabalhar

- Evoluir a base existente e preservar alterações do usuário. Implementações no checkout principal e branch `dev`, sem worktree de desenvolvimento salvo pedido explícito.
- `main` é a referência estável promovida com autorização; não tratar o antigo commit 00a0a09 como main atual.
- Reutilizar `waia-test` nas validações Docker, preservando projetos e volumes existentes. Não criar projeto permanente por fase nem remover ambientes sem autorização explícita.
- Antes de restore ou teste que exija alvo vazio, confirmar isolamento e autorização; não apagar `waia-test` para satisfazer instrução antiga de homologação.
- Configurar clientes pelo painel, sem `.env`, SQL, seed, código, reinício ou deploy por tenant. Segredos só em canais/cofres adequados; diagnósticos por status e metadados sanitizados.
- Priorizar proteger funcionamento atual em urgências; registrar débitos. Distinguir implementado, planejado e dependente de decisão.
- Verificações proporcionais ao risco, com resultados e limites claros. Não declarar integrações reais comprovadas por testes em memória.
- Ao final de cada alteração, atualizar `package.json` e `package-lock.json`: patch para correção/documentação, minor para capacidade compatível, major para quebra deliberada de contrato.
- A versão alvo 2.0.0 só é entrega quando seus gates estiverem cumpridos; não antecipar versão estável por planejamento ou implementação parcial.
- Antes de cada commit, apresentar arquivos, validações, versão e mensagem, e aguardar confirmação explícita.
- Após confirmação, fazer commit com versão no título e push de `dev`; aguardar nova confirmação antes da próxima fase. Promoção de main/deploy seguem autorização específica.

## Aprendizado de preferências

- Registrar aqui apenas preferências estáveis e reiteradas de colaboração, de forma curta; informar o usuário ao alterar.
- Não registrar pedidos pontuais como hábito, dados sensíveis ou suposições. Atualizações de memória externa dependem de pedido explícito.

## Documentos preservados

- `docs/OPERACAO_RELEASE.md`: build, backup, restore, deploy e rollback.
- `docs/ACEITES_FASE_11.md`: aceites históricos do piloto, sem estendê-los automaticamente ao SaaS público.
- `docs/ARQUITETURA.md` e `docs/CONFIGURACAO_INTEGRACOES.md`: referência da base existente; mudanças futuras estão no plano 2.0.0.
