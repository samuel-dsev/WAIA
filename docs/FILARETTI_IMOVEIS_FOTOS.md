# Filaretti Imóveis — correção de triagem e fotos da ficha

Correção preparada na linha estável `1.28.6`, sobre a produção `1.28.5`. Sem nova migração, dependência ou alteração automática de configuração de cliente.

## Diagnóstico e correção

A leitura de produção identificou Filaretti Imóveis ativa na revisão 5, rascunho 51, qualificação e atendimento contextual habilitados, avaliação automotiva e encaminhamento de fotos desabilitados. Grupo FCI habilitado na revisão 3 e remetente conectado. Roteiro publicado identificado pelo SHA-256 `51cd6de36473c315c31ae84f9da9654d7ed49cc6d8dc82f24fc4490a787a1b88`.

O atendimento revisado estava pausado e foi preservado. As fotos estavam armazenadas. Após informar a expectativa de aluguel de 1500 com condomínio incluso, ocorreu `AI_INVALID_LEAD_QUALIFICATION`; a resposta seguinte compreendeu o valor e pediu o nome. Não há registro da resposta bruta do modelo que permita afirmar qual campo falhou naquela tentativa.

Uma reprodução com dados fictícios confirmou que uma ficha parcial inválida podia substituir uma pergunta compreendida por contingência, mesmo após reavaliação. A correção conserva uma pergunta útil do modelo, após a tentativa de reparação, somente em atendimento imobiliário ou qualificação com fotos fora da avaliação automotiva. A ficha inválida e as ações são descartadas; nenhuma conclusão ou encaminhamento é aceito por esse caminho. Promessas de contato do corretor também são reconhecidas pelo detector de fechamento e não são preservadas como simples coleta.

O controle de fotos da ficha passa a exigir atendimento contextual, qualificação completa e atendimento humano, sem obrigar avaliação de veículos. A IA recebe a confirmação das imagens armazenadas e continua pelos critérios publicados. Fotos e nome não substituem localização, valores ou demais critérios da captação. A exceção de conclusão por nome/fotos da avaliação automotiva permanece restrita a esse percurso.

Na ficha válida, a contagem das fotos é acrescentada se houver espaço, sem invalidar um resumo já no limite permitido. Os anexos usam a fila privada existente, remetente e destino configurados, com revalidação de publicação, privacidade e fonte. A ficha vem antes das imagens; aceite conhecido não é repetido após reinício. Fotos posteriores seguem no mesmo atendimento sem nova ficha ou reativação da IA. Sem análise visual ou avaliação de preço por imagem.

## Ativação pelo painel

Depois da publicação da 1.28.6:

1. Selecionar **Filaretti Imóveis** e conferir revisão ativa, rascunho e eventuais diferenças preexistentes.
2. Manter **Atendimento contextual** e **Qualificar leads** habilitados, **Avaliação de veículos na troca** desabilitada e os critérios/roteiro atuais preservados.
3. Marcar somente **Encaminhar fotos recebidas com a ficha do lead**. Salvar, validar e publicar pelo fluxo normal da empresa.
4. Conferir leitura posterior: flag de fotos ativa, avaliação automotiva desativada, grupo FCI e demais configurações preservados. Não reabrir o atendimento já pausado ou reenviar fotos antigas para testar.

A mudança de capacidade no código não habilita empresas. A configuração deve ser feita pelo painel; não usar SQL, `.env`, seed ou código por tenant como alternativa. O controle do navegador retornou timeout nesta preparação e a ativação não foi concluída.

## Validação e estado

Suíte geral preliminar Node 22: 756 aprovados/32 condicionais ignorados; regressão dirigida final: 105 aprovados, zero falhas. PostgreSQL: 30 casos aprovados, incluindo avaliação automotiva, captação imobiliária sem catálogo/avaliação automotiva, armazenamento e envio dos bytes, ordem resumo/imagens, deduplicação, reinício, anexos posteriores, RLS, revogação entre leitura/envio e regressão do follow-up. As 140 tabelas anteriores foram preservadas por contagem/hash; banco isolado existente reutilizado e serviço devolvido ao estado parado.

Casos de IA usam provedor e transporte sintéticos. Comprovam contratos e efeitos do pipeline, sem certificar interpretação de uma resposta futura do modelo real ou recebimento no WhatsApp/grupo. Não houve mensagem externa de teste, configuração de tenant por SQL, publicação, push ou alteração na branch `new`/2.0 nesta preparação. A validação final da imagem e a autorização de publicação são registradas no relatório de continuidade.
