# Encaminhamento de triagem sem nome

Implementação na linha estável, branch **dev**, checkout principal **WAIA**, sobre **1.28.6**; nova capacidade compatível **1.29.0**. Prazo confirmado pelo titular em 24/11/2026: **15 minutos** após o envio confirmado da última pergunta pelo nome, sem nova resposta do cliente. Capacidade compartilhada entre empresas, sem configuração por ID ou ramo e sem depender da ativação de follow-up.

## Regra

A IA deve conferir os critérios publicados da empresa e preparar `awaiting_name` somente quando faltar **exclusivamente o nome**. Os demais dados, consentimentos e requisitos da finalidade precisam estar completos: avaliação por fotos, simulação, triagem comercial simples ou atendimento de outro ramo. `collecting` continua representando coleta incompleta; perguntar o nome no início não habilita o encaminhamento por silêncio.

A pergunta final continua sendo enviada normalmente. A ficha factual fica no checkpoint privado da resposta, com `name=null`, resumo, dados coletados e qualificação operacional. O relógio só começa após o provedor confirmar o envio da pergunta. O job durável carrega apenas referências e a geração da conversa, sem copiar dados pessoais. Reinício e confirmação repetida não reiniciam o prazo.

Após 15 minutos, o worker revalida conversa, configuração, contato, canal, permissão de atendimento e destino de grupo. Registra a ficha e o envio pendente no notificador e pausa somente aquela conversa, na mesma transação. O notificador usa as confirmações e a política existente de tentativas/resultado incerto; enfileirar não comprova recebimento no grupo. O bot permanece pausado para atendimento humano, inclusive se o cliente responder depois.

A ficha informa **“NOME NÃO INFORMADO”**, preserva os dados e o WhatsApp do contato e não inventa identidade nem classifica o silêncio como baixa qualificação. Com encaminhamento de imagens habilitado, inclui as fotos armazenadas de todo o turno, inclusive várias imagens agrupadas e captação imobiliária sem avaliação automotiva; imagens posteriores seguem o encaminhamento já existente sem reativar o bot. Ciclos e ações pendentes de follow-up desse chat são cancelados ao encaminhar.

## Cancelamento e disponibilidade

- Qualquer nova mensagem do cliente invalida o timer anterior, incluindo nome, recusa ou mudança de assunto. O atendimento normal interpreta a resposta e pode concluir com nome ou preparar nova pergunta final, quando cabível.
- Pausa/assunção humana, retomada com outra geração, conversa fechada, alteração da revisão, bloqueio, revogação de consentimento, exclusão e expiração/remoção de evidências impedem o encaminhamento antigo.
- Sem IA/triagem publicada, canal/permissão disponíveis e grupo habilitado, o timer não cria ficha nem pausa o chat. A configuração continua sendo feita pelo painel.
- O timer futuro não bloqueia o processamento de mensagens normais. A unicidade da ficha por conversa e do job por pergunta confirmada impede duplicidade.
- Não se aplica retroativamente a perguntas antigas sem o novo checkpoint. Não solicita documentos extras, não muda o roteiro publicado e não dispensa outros critérios obrigatórios.

## Validação e limites

Testes em memória cobrem ficha incompleta, pergunta final, empresas de outros ramos, triagem simples, financiamento com documentos/entrada e avaliação com consentimento/fotos. PostgreSQL real no banco de teste existente cobre prazo, confirmação repetida, recriação do repositório, nova resposta antes do disparo, pausa/retomada, exclusão, configuração/rota, isolamento/RLS, múltiplas fotos e cancelamento de follow-up. Fixtures em rollback e hashes/contagens das 140 tabelas preservados; sem migração nova.

A classificação de “falta somente nome” depende da interpretação da IA dos critérios publicados, com os guardas existentes de consentimento, financiamento e avaliação. Os testes não comprovam IA real nem entrega WhatsApp/grupo. Publicação em produção exige autorização própria.
