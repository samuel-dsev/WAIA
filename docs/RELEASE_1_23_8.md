# Correção contextual do atendimento — 1.23.8

Porte autorizado da candidata `2.0.0-rc.37`/`88cf938`, sobre a produção `1.23.7`/`cd6307c`. O roteiro orienta objetivos e limites; a IA recebe todo o histórico retido do chat e as mensagens do turno em ordem. Textos são reunidos após 15 segundos sem nova entrada, mesmo quando a espera antiga estava desativada. Nova entrada invalida inferência/checkpoint ainda não enviado; o dispatch do turno é reivindicado sob lock e incerteza de envio não dispara repetição automática.

O aceite de financiamento depende da pergunta atual ou de pendência confirmada. Fotos e outras solicitações interrompem a coleta sem encerrar pelo nome nem perder a pendência. Dois modelos distintos recebem ambas as galerias. O painel explica o agrupamento obrigatório. Comandos explícitos de encaminhamento humano preservam o contrato da linha estável.

Sem migração, dependência ou alteração de configuração de tenant. API e worker usam a nova imagem; o painel recebe somente `onboarding.js`, preservando os demais assets publicados. PostgreSQL, Redis, monitor e remetente de grupos permanecem na composição existente.

Validação antes do empacotamento: 601 testes locais aprovados, 23 opt-in ignorados, zero falhas. Três regressões com código portado e PostgreSQL real aprovadas no `waia_v2_upgrade`, sem migrações e com hashes das 135 tabelas preservados. As fixtures atuais são compatíveis com esse alvo; os testes legados que exigem banco temporário exclusivo não foram adaptados para contornar essa restrição.

Imagem Linux e artefatos identificados por versão/commit, checksum e Image ID; a implantação deve reutilizar a mesma imagem validada, com backup verificado e rollback para a release anterior. Resultados de implantação e limites externos ficam no relatório ativo do checkout principal. Não se certifica entrega real no WhatsApp por simulação local.
