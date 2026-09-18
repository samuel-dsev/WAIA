# Contas de cliente — F1 / v1.11.0

Implementação local em 18/09/2026. Portal em `/portal/`, API de identidade em `/api/account/v1`, empresas em `/api/app/v1/companies`. O painel administrativo mantém seu perímetro e cookie próprios. F2 entrega equipe/MFA; F3 entrega configuração do atendimento.

## Configuração única da plataforma

Aplicar migrações 021 e 022 com o migrador antes de iniciar a nova imagem. As 20 migrações anteriores são preservadas. Nenhum tenant legado recebe proprietário inferido, ativação ou envio automático de e-mail.

As contas ficam desligadas por padrão (`CUSTOMER_ACCOUNTS_ENABLED=false`). Para ambiente autorizado, definir a origem exata em `CUSTOMER_PORTAL_ORIGIN`, o limite de empresas por usuário em `CUSTOMER_COMPANY_LIMIT` (padrão 1), keyring e pepper já usados pela infraestrutura. A origem deve ser HTTPS e o cookie seguro em produção. API e worker precisam da mesma configuração. Isso é configuração da plataforma; cada cliente usa apenas o portal.

`CUSTOMER_SESSION_MS`, `CUSTOMER_IDLE_MS`, `CUSTOMER_VERIFY_MS` e `CUSTOMER_RESET_MS` controlam respectivamente sessão absoluta, inatividade, confirmação e recuperação. Padrões: 12h, 1h, 24h e 30min. `TRUST_PROXY` aceita IPs/sub-redes dos proxies confiáveis conforme Express; vazio desconfia de cabeçalhos encaminhados nas APIs públicas. Não usar valores genéricos sem conhecer a cadeia de proxies. O comportamento administrativo existente é preservado.

`ACCOUNT_EMAIL_MODE=fake` só funciona em desenvolvimento/teste e não envia mensagens. O modo `http` requer `ACCOUNT_EMAIL_ENDPOINT` HTTPS, `ACCOUNT_EMAIL_TOKEN` e `ACCOUNT_EMAIL_FROM`, todos globais e mantidos em cofre/ambiente apropriado. Nunca fornecer esses valores pelo portal.

## Contrato de e-mail e limite da entrega

O adapter HTTP chama um gateway transacional configurado pela plataforma. Ele não equivale a uma integração homologada com um fornecedor específico. Envia POST JSON `{from,to,template,variables:{url}}`, autenticação Bearer e cabeçalho `idempotency-key`. Templates: `verify`, `reset` e `password_changed` (este sem URL). Resposta 2xx confirma aceitação. Timeout de 10 segundos; redirects recusados. O gateway deve implementar templates e idempotência; domínio/remetente, entrega, spam e bounce ainda precisam de homologação antes da exposição pública.

Tokens têm 256 bits aleatórios, digest no banco, expiração e consumo único. Links usam fragmento removido da URL pelo portal; GET não consome token. A outbox guarda o conteúdo cifrado e remove o envelope após sucesso, esgotamento das tentativas ou expiração. O worker tenta uma entrega por ciclo de cinco segundos, com lease de 60s, até cinco tentativas e atraso exponencial. Falhas persistem como status sem conteúdo sensível. Inspecionar somente status, tentativas e datas em suporte.

## Comportamento e compatibilidade

Cadastro/recuperação/reenvio retornam mensagem neutra. Um cadastro duplicado não modifica identidade, senha ou papel. Novas senhas exigem 12–128 caracteres; login aceita até 256 para compatibilidade legada. Contas já protegidas por MFA não podem entrar pelo portal até a F2; o reset nunca remove MFA.

Sessões customer e admin são separadas por audience e pepper derivado. Operações mutáveis exigem origem exata e, quando autenticadas, CSRF. Reset/troca de senha revogam as sessões de ambas as superfícies. A identidade continua global: mudanças de nome/senha refletem no usuário existente, sem conceder poder de plataforma.

Criar empresa exige e-mail confirmado. Uma transação cria empresa rascunho, vínculo administrador, proprietário, rascunho V2 com IA desligada, progresso inicial e auditoria. Limite e idempotência são serializados por usuário; mesma chave e dados repetem o resultado por 24h, dados diferentes retornam conflito. Retomar sessão lista somente vínculos ativos, sem bypass por papel global. Não há cobrança, ativação automática, contratação ou nova conexão WhatsApp.

O aceite inicial é registrado em auditoria. A versão final dos termos e políticas do SaaS permanece no gate F8; as páginas existentes não representam aprovação jurídica da nova oferta.

## Validação e operação

`npm test` executa regressão local; as integrações opt-in aparecem como skips. Para testar a F1 em alvo de homologação autorizado e com migrações aplicadas, usar `RUN_POSTGRES_INTEGRATION=true`, `RUN_REDIS_INTEGRATION=true`, `DATABASE_URL` da role restrita, `DATABASE_MIGRATOR_URL` do migrador e `REDIS_URL`, executando `node --test test/accounts-postgres.test.js test/accounts-redis.test.js`. Os testes criam identidades sintéticas de UUID próprio e limpam somente suas fixtures; não precisam de banco vazio. O teste de rollback usa trigger temporário limitado à identidade sintética, removido em finally.

Desabilitar a flag encerra a superfície pública e a entrega de e-mail na próxima inicialização; não desfaz alterações de senha já solicitadas. Rollback de imagem mantém schema aditivo e dados. Nunca remover tabelas/colunas para rollback; seguir backup e recuperação de `OPERACAO_RELEASE.md` antes de qualquer implantação autorizada. Nenhuma publicação em produção integra esta entrega local.
