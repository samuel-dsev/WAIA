# Follow-up individual — linha estável

**Ajuste 1.28.5, publicado em 24/11/2026 sobre 1.28.4:** novas conversas recebidas pelo webhook iniciam o follow-up por padrão quando a empresa já o habilitou e os critérios de disponibilidade estão atendidos. Usa os períodos e o fechamento já salvos no painel, inclusive o perfil personalizado. Nenhuma configuração, seleção individual ou ciclo existente é atualizado retroativamente. Na publicação, os nove ciclos ativos e a política personalizada da Turim foram preservados; [evidências e limites](DEPLOY_1.28.5.md).

Implementação autorizada em 20/11/2026, incluindo a alteração posterior para períodos editáveis em horas. Escopo: follow-up individual; campanhas em massa/E9A integral continuam fora desta entrega. Atendimento padrão, roteiro, critérios, catálogo e fechamento preservados.

## Controles e calendário

- Todas as empresas continuam desabilitadas até configuração pelo painel. Com a empresa habilitada, a primeira entrada real de uma conversa nova inicia o ciclo por padrão, respeitando o piloto autorizado, a IA ativa e os critérios de disponibilidade. Conversas existentes permanecem como estavam. Duplicatas, mensagens posteriores e retomadas de contato com ciclo anterior não ativam nem reiniciam o follow-up. Não há habilitação de empresa por nome, seed, SQL ou ambiente.
- Painel: selecionar empresa → Conversas/Contatos → **Follow-up da empresa**. O botão **Follow-up** do contato abre sua conversa e a ativação individual. Portal: **Follow-up automático** dentro da conversa, sujeito a permissões e X04.
- Empresa ativa com IA publicada e habilitada; conversa aberta em modo bot; contato/canal disponíveis. Pausa, bloqueio, consentimento revogado ou exclusão solicitada impedem disparos.
- A ativação automática inicia o contador na entrada da conversa nova. Marcar manualmente o contato continua iniciando o contador **naquele momento**, independentemente da idade do histórico. Cada contato tem âncora, origem, contexto e sequência próprios. Triagem concluída bloqueia disparos mesmo que o chat ainda esteja em modo bot.
- Teste: **2, 5, 10 e 15 minutos**, fechamento aos **20 minutos**. Normal: **2h, 24h, 48h e 72h**, fechamento às **96h**. Prazos absolutos desde a ativação, não intervalos somados entre mensagens.
- Editar/adicionar/remover períodos em horas, inclusive frações (`0,5` hora = 30 minutos). Até 20 mensagens; prazos positivos, distintos e crescentes. É possível remover todos e manter só o fechamento. Este é editável e precisa ser posterior ao último disparo.
- Salvar a política cancela ciclos existentes, sem habilitar contatos. O operador marca novamente os desejados. A política de um ciclo fica registrada; não troca prazos silenciosamente.
- Para adotar o novo padrão após a publicação da 1.28.5, não é necessário salvar novamente a política da empresa. Assim, os ciclos já ativados e seus contadores permanecem preservados.
- Pausar/assumir/fechar cancela próximos disparos. Devolver ao bot não reinicia automaticamente. Períodos vencidos durante indisponibilidade não saem em rajada.

## Atendimento e fichas

A IA de follow-up tem prompt/schema próprios e usa todo o histórico retido, incluindo perguntas antigas. Reformula a pendência, com mensagens curtas e uma pergunta simples; varia a abordagem e oferece vendedor em algumas retomadas. Não inventa preço, estoque, descontos, urgência ou encaminhamento realizado. Usa o provedor/orçamento de IA existentes.

Entrada do cliente invalida disparo preparado antes do claim. O atendimento normal continua pelo fluxo existente; pergunta nova pode ser retomada na próxima oportunidade do mesmo ciclo, sem repor tentativas.

| Situação no fechamento | Resultado |
|---|---|
| Apenas mensagem inicial, sem outra interação | Encerra só o ciclo; mantém chat em bot; sem ficha de grupo |
| Interação além da inicial, triagem incompleta | Ficha separada de baixa qualificação, com contexto/interesse disponível e telefone, sem nome fictício |
| Triagem concluída depois de follow-up aceito | Finalização/pausa pelo mecanismo existente; notificador identifica boa qualificação, triagem concluída e informações coletadas |
| Desinteresse em resposta ao follow-up | Cancela ciclo, oferece disponibilidade e pausa somente esse chat; sem ficha de grupo |

Recusa é interceptada somente em resposta a um follow-up aceito em ciclo ativo. Não intercepta contatos sem opt-in nem recusas normais de fotos/financiamento/troca. Cortesia tem prova da pausa própria; falha de envio não libera o bot. Classificação determinística cobre recusas explícitas/cortesia contextualizada, sem certificar toda linguagem natural.

Ficha incompleta usa assunto tipado no notificador, preservando os mínimos de `qualified_leads`. Destino ausente mantém pendência consultável na conversa; habilitar rota pelo painel permite enfileirar a mesma ficha. Qualificação posterior torna a incompleta obsoleta antes do dispatch. Empresa, canal, rota, fonte e retenção são revalidados.

## Conversas antigas e templates

O contador aceita histórico antigo, mas texto livre requer janela de 24h desde a última entrada real. Fora dela, cada período pode apontar para **template de marketing aprovado** no próprio WABA, com idioma e uma variável de texto no corpo (`{{1}}`) para a retomada contextual. Aprovação/identidade/conteúdo são consultados no provedor antes do claim. Sem template válido, a tentativa fica bloqueada; não envia texto livre nem gasta geração desnecessária.

Não se criam/submetem templates pelo WAIA. Piloto aceita corpo com um parâmetro e rodapé estático; cabeçalhos, botões e múltiplas variáveis não são suportados neste controle. Nenhum template ou saldo externo foi configurado nesta entrega.

Referências consultadas: [janela/templates WhatsApp](https://www.twilio.com/docs/whatsapp/key-concepts), [templates YCloud](https://docs.ycloud.com/reference/whatsapp_template-list), [SDK oficial YCloud e consulta por nome/idioma](https://github.com/YCloud-Developers/ycloud-sdk-go), [respostas curtas — Salesforce](https://help.salesforce.com/s/articleView?id=sf.livemessage_create_automated_responses.htm&language=en_US&type=5). Contexto, brevidade e uma pergunta são escolhas editoriais, sem promessa de aumento de conversão.

## Persistência e evidências

Migrações aditivas **060–062**, com RLS/FKs, política, ciclos, ações, fichas e versões. Migrações aplicadas não foram editadas. Reutiliza outbox/fila/worker e serialização por conversa; Redis recebe somente referências. Timers futuros não bloqueiam atendimento normal.

Dispatch revalida conversa/geração, configuração, política, canal, privacidade e watermark em transação curta; rede/IA ficam fora dos locks. Mensagem iniciada pode chegar; timeout/crash fica incerto, sem retry cego. Rascunhos e resumos internos não entram como mensagens enviadas. Na IA global só a retomada aceita entra no transcript, sem duplicar uma entrada antiga.

Testes PostgreSQL reutilizam `waia-test`/`waia_v2_upgrade`, com rollback de fixtures e hashes/contagens das tabelas existentes. Revisão visual usa APIs fictícias locais; não certifica banco ou fornecedor. Contagens e evidências finais no relatório ativo. Prova externa de IA real, recebimento de WhatsApp/template e entrega ao grupo permanecem pendentes.

## Histórico do piloto e da publicação inicial

Nenhuma configuração da Turim foi alterada e nenhum contato foi marcado. O titular escolheu marcar contatos pessoalmente. Após autorização específica e gates operacionais: portar o incremento à linha estável, publicar imagem aprovada e, **pelo painel**, habilitar apenas Turim no preset de teste, preservando revisão/roteiro, contas, credenciais, limites e grupo. Conferir contatos desmarcados; ativação individual cabe ao titular.

Sem push, promoção de main/2.0.0 ou deploy nesta etapa. Mensagem de commit: `v2.0.0-rc.79 - adiciona follow-up individual e periodos editaveis`.


Porte estável a partir de 1.27.1/88fd87c, mantendo os subsistemas legados: painel administrativo e quota de IA atuais, sem importar E4A/portal/IA global da candidata. A recusa ao follow-up usa checkpoint próprio e transação curta, preservando o dispatcher padrão. Função de audiência de compatibilidade é criada somente quando ausente. Validações locais: 737 testes aprovados, 30 condicionais; 12 PostgreSQL com 140 tabelas preservadas; duas capturas desktop/mobile. Habilitação da Turim será feita pelo titular no painel, conforme seu último pedido.
