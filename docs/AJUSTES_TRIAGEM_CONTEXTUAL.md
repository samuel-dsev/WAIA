# Correções de atendimento e triagem — 1.29.1

Implementadas em 24/11/2026 no checkout WAIA, branch `dev`, sobre a 1.29.0. Correção compatível dos processos existentes; sem migração, dependência ou mudança de configuração por empresa. Os exemplos recebidos foram usados como evidência do problema e transformados em fixtures fictícias; números e imagens reais não foram incorporados ao produto.

## Comportamento

- Ao confirmar financiamento em resposta à dúvida do cliente, manter as condições publicadas e oferecer simulação como próximo passo. O convite não autoriza pedir documentos.
- Interpretar todas as mensagens do turno. Nome junto de cidade, explicações e dúvidas é aproveitado; responder ao que puder ser esclarecido e concluir na mesma resposta quando os demais critérios estiverem completos. Pedido novo de fotos, busca ou comparação é cumprido antes de encerrar.
- Na triagem contextual comercial de veículos, financiamento e avaliação são caminhos opcionais. Interesse explícito de compra/negociação ou confirmação da continuidade com vendedor também permite concluir com os dados existentes. Cotação isolada e silêncio não comprovam interesse. Ao recusar/adiar métodos, interromper as ofertas repetidas e confirmar o objetivo real. Recusa de contato impede essa ficha.
- A confirmação comercial exige evidências de mensagens originais; aceite curto só vale para a oferta de interesse/continuidade correspondente. Anúncio, citação, sugestão da IA e aceite de simulação não substituem essa confirmação. A confirmação anterior é preservada quando depois chega o nome; recusa posterior a invalida.
- Com interesse confirmado e faltando somente nome, preparar `awaiting_name`. Preservar modelo de interesse, troca, orçamento, cidade, características e histórico declarados, métodos adiados e demais informações coletadas. O WhatsApp é acrescentado pelo sistema. O prazo existente de **15 minutos após envio confirmado da pergunta, sem nova resposta**, continua encaminhando e pausando somente esse chat.
- Consultas do estoque de veículos aceitam modelos alternativos, intervalo de anos, categoria e faixa de preço. Mais opções mantém a consulta; refinamento por nome preserva o orçamento anterior quando não houver alteração explícita. Ano desconhecido não satisfaz filtro por ano; semelhança parcial não transforma Polo Track em Tracker.
- Pedido de modelo mais antigo usa o veículo/ano discutidos. Responder à disponibilidade sem lista geral; resultados são limitados a três por página. Se não houver correspondência, informar primeiro a ausência e mostrar até três alternativas, explicitando diferenças e respeitando os demais filtros. Se não houver alternativas, perguntar sobre outro modelo/faixa, sem inventar estoque.

## Casos de regressão

| Situação | Resultado esperado |
| --- | --- |
| Financia sem entrada? | Resposta pelas condições publicadas + convite, sem CPF/nascimento antecipados. |
| Nome, cidade e onde fica a loja em três mensagens | Resposta à localização + fechamento e ficha com nome/cidade. |
| Nome veio, IA volta a pedir nome | Uma reavaliação contextual, dentro do limite total de duas chamadas. |
| Só fazendo cotações após oferta de avaliação | Parar de insistir nos métodos e confirmar interesse real. |
| Interesse confirmado, fotos adiadas, falta nome | Pergunta final de nome e ficha factual pronta para o prazo existente. |
| Nome já conhecido, sem documentos nem fotos | Pode concluir por interesse confirmado; não inventa simulação/avaliação. |
| Nome acompanhado de novo pedido de fotos | Enviar galeria solicitada e manter triagem aberta. |
| Sim após oferta de simulação | Não comprova interesse/contato comercial por esse novo caminho. |
| Não quero contato depois de confirmar | Não conclui pela confirmação antiga. |
| Compass mais antigo após preço do 2023 | Busca contextual por Compass anterior ao ano discutido. |
| Onix ou Etios 2017/2018 até 50 mil | Apenas modelos/anos/orçamento compatíveis; alternativas são identificadas como tais. |
| Busco Onix, Etios, Polo após limite de 50 mil | Mantém limite; não envia estoque completo. |
| Modelo ausente ou ano desconhecido | Não inventa correspondência nem amplia filtros silenciosamente. |
| Mais opções após reiniciar repositório | Mantém modelos, anos e valores persistidos; avança só pelos envios confirmados. |

## Alcance e limites

A compreensão de nome e resposta no mesmo turno melhora o atendimento contextual compartilhado. O caminho comercial sem financiamento/fotos é específico da triagem contextual de veículos com catálogo do site; não dispensa os critérios da triagem simples, jurídica ou imobiliária. As configurações e o ciclo de follow-up permanecem iguais, sem reinício por resposta do cliente. Pausa, confirmação de envio, grupo e isolamento usam os fluxos existentes.

Validações e estado de entrega estão na entrada 1.29.1 do `RELATORIO.md`. Testes com respostas de IA e transporte fictícios não comprovam comportamento do modelo real ou recebimento externo. Sem reabertura dos atendimentos analisados, envio externo de teste ou publicação em produção nesta etapa.
