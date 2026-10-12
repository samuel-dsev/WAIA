# Contatos no painel — v1.14.1

Preparada em 11/10/2026, no checkout principal e branch `dev`, sobre `2b7ce50` (v1.14.0), por pedido específico. Usuário definiu v1.14.1 pelo tamanho pontual da alteração e aprovou commit, push e deploy após apresentação. Execução em andamento; não fecha a F6 do SaaS.

## Comportamento

- Conversas e mensagens: Contato mostra o nome salvo, ou `none`; Número mostra o telefone normalizado do cliente. O banco já possui esse telefone em texto, sem necessidade de descriptografar. O painel anteriormente exibia IDs internos. Campos adicionais ficam sujeitos à autenticação, isolamento e auditoria de leitura de PII existentes.
- Administradores da plataforma/empresa podem editar o nome na coluna Contato, nos detalhes da conversa e na tela Contatos. Campo vazio salva `null` e volta a exibir `none`. Operadores mantêm leitura, sem novo poder de exclusão/edição de contato.
- Excluir número exige confirmação no painel e usa `DELETE /api/admin/tenants/:empresaId/contacts/:id`. Afeta todas as conversas desse contato na empresa selecionada, inclusive em diferentes números de atendimento. A edição usa o PATCH de contatos existente.
- Na mesma transação da auditoria, bloqueia o contato para trabalhos antigos, marca sua exclusão lógica, arquiva/pausa conversas, limpa nome, texto/payload de mensagens e estado persistido, inclusive cooldown e dados aprendidos. Jobs de entrada/envio humano pendentes, publicados ou falhos tornam-se concluídos para impedir reenvio. Exportações de pedidos continuam com seus estados existentes.
- Se um job de atendimento estiver `em_publicacao`, a exclusão retorna HTTP 409 e não altera dados. O administrador deve aguardar a conclusão e tentar novamente. Locks de contato/conversas/jobs serializam essa decisão com webhook e claim do worker.
- Listagens/detalhes administrativos de conversas/mensagens e acesso à mídia ocultam contatos excluídos. Workers não carregam mensagens de contatos excluídos. O próximo webhook com mensagem inédita cria contato e conversa novos pelo contrato existente, sem herdar nome, histórico, pausa ou cooldown.

## Preservação operacional

Exclusão voltada ao reinício do atendimento, sem remover linhas exigidas por FKs de pedidos, agendamentos, consumo e auditoria. IDs/external IDs permanecem para evitar replay de mensagens antigas. Telefone da identidade aposentada e referências operacionais permanecem no banco; dados de pedidos/formulários e mídias seguem as retenções existentes. Mensagens não são removidas do WhatsApp nem de backups. Não é ferramenta de expurgo integral de dados.

Nenhuma migração, configuração de tenant, credencial ou mudança de provedor nesta entrega. Alterações de equipe/MFA anteriores ao pedido foram preservadas e excluídas da candidata.

## Arquivos deste escopo

- `panel/app.js` (somente hunks deste pedido), `panel/styles.css`.
- `src/modules/admin/postgres-admin-repository.js`, `src/modules/admin/memory-admin-repository.js`, `src/modules/jobs/handlers.js`.
- `test/contact-panel.test.js`, `test/contact-reset-postgres.test.js`, `test/postgres-admin-repository.test.js`.
- `package.json`, `package-lock.json` (patch definido pelo usuário para esta alteração pontual, 1.14.1).
- `PLAN.md`, `RELATORIO.md`, este documento; `.gitignore` libera o novo documento para versionamento.

Mensagem proposta para eventual commit aprovado: `v1.14.1 - adiciona edição de contatos e reinício do atendimento pelo painel`.

## Evidência e limites

- Candidata criada de `git archive HEAD` + somente estes arquivos/hunks: Node 24, 462 casos, 446 aprovados, 16 skips, zero falhas. Testes específicos incluem isolamento entre empresas, nome/telefone, limpeza de estado/histórico, preservação de exportação, cancelamento de fila, conflitos e rollback de auditoria.
- Chrome com API real do módulo administrativo usando repositório em memória: desktop 1440×900 e mobile 390×844; edição, detalhes, cancelamento/Escape após confirmação anterior, HTTP 409, exclusão, lista vazia e novo contato sem nome anterior. Sem erro JavaScript ou overflow horizontal. Evidência local em `.tmp/contact-panel/desktop.png`, `.tmp/contact-panel/mobile.png`, `.tmp/contact-panel/candidate-tests.tap`; `.tmp/contact-panel/app-only.patch` separa a edição de `panel/app.js` do trabalho anterior.
- Corrigido o estado vazio que era ocultado após renderizar a lista e reinicializado `returnValue` do diálogo para Escape não reutilizar confirmação anterior.
- Após a aprovação, Docker disponível: candidata em Node 22, 462 casos, 446 aprovados, 16 skips opt-in, zero falhas; auditoria de dependências da imagem com zero vulnerabilidades.
- PostgreSQL 16 de `waia-test`: banco temporário exclusivo e migrado, sem alterar o banco existente. Teste opt-in aprovado com role da aplicação: exclusão sob processamento retorna 409 sem alterar conteúdo; isolamento entre empresas, cancelamento do job, limpeza de histórico/estado, replay ignorado e novo contato/conversa pelo próximo webhook. Fixtures em transação encerrada com rollback; banco temporário removido e serviço devolvido ao estado parado.
- UI sintética e testes locais não comprovam atendimento real da IA ou recebimento/envio WhatsApp. Concorrência real com workers ativos não foi exercitada. Publicação e smoke da release em andamento, mediante autorização recebida.
