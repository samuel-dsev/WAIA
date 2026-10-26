# M10 — entrega técnica local e roteiro de aceite

26/10/2026. Autorização inicial em25/10/2026. Base `8361597` / 2.0.0-rc.1, checkout principal `new`, entrega **2.0.0-rc.2**. O usuário autorizou concluir a M10 e o planejamento **somente localmente**, preservando a versão em deploy na VPS, com dados fictícios e sem API keys/conexões externas. Essa decisão encerra a implementação local M0–M10 e adia os gates de operação externa. O teste manual do titular ainda está pendente; não foi convertido em aceite por testes automatizados. Estável2.0.0 permanece condicionada a esse aceite e à definição dos gates aplicáveis ao alvo final.

Nenhuma operação foi direcionada à VPS. Sem push, promoção de branches, DNS, túnel público, provedor real, importação de empresas antigas ou alteração da instalação em deploy.

## Abrir o sistema

| Superfície | Endereço |
|---|---|
| Início, login e empresas do cliente | **http://127.0.0.1:5035/** |
| Administração geral | **http://127.0.0.1:5035/panel/** |

O servidor fica ligado para o teste manual. API, PostgreSQL, Redis e mídia reutilizam o ambiente v2 do projeto `waia-test`; não há projeto permanente por fase. API somente na rede interna, proxy somente em loopback5035. O proxy e a API executam os scripts/assets da mesma imagem entregue, sem montar código do checkout. O processo de atendimento/worker e as conexões externas ficam desligados. Há somente entrega fictícia de e-mails dentro do ambiente.

**Acessos:** arquivo privado `.secrets/ACESSOS_TESTE_LOCAL.md`. Ele contém apenas senhas dos acessos fictícios e instruções de MFA do administrador. Não contém chaves de provedores ou infraestrutura e não é versionado. O cliente recomendado para a primeira visita é `teste.local@waia.example`; o administrador é `admin.local@waia.example`. Senhas/MFA existentes foram preservados.

Para MFA administrativo, adicionar a chave existente ao aplicativo autenticador ou usar o QR privado `.secrets/MFA_ADMIN_LOCAL.png`. Alternativa: gerar um código local e ler `.secrets/CODIGO_MFA_LOCAL.txt`:

```powershell
rtk proxy node scripts/local-test-access.mjs code
```

O código expira em30s e é de uso único. Se acabou de utilizá-lo, aguardar o próximo período. Nenhum código é impresso no stdout do helper. Para regenerar o documento de acessos e o QR sem redefinir identidades:

```powershell
rtk proxy node scripts/local-test-access.mjs access --qr
```

## Dataset de demonstração

Quatro empresas fictícias configuradas pela interface administrativa: **Aurora Serviços Demo**, **Horizonte Comércio Demo**, **Vale Atendimento Demo** e **Jardim Consultoria Demo**. Identidade/segmento/endereço fictícios, roteiro único, mensagens, horários, regras, política local, menu e um item de catálogo por empresa. Preço de demonstração149,90. IA selecionada como simulada, sem chave; nenhum cadastro de token, número real, app/conexão externa ou destino de grupo para contornar readiness.

| Acesso fictício | Uso |
|---|---|
| Teste Local M10 | Uma empresa, Jardim, com leitura/edição e capacidades de simular/publicar sujeitas à prontidão |
| Ana Demo | Aurora/Horizonte, comparação entre duas empresas |
| Bia Demo | Leitura/MFA conforme vínculo existente; usar o autenticador, sem consumir recovery codes por rotina |
| Caio Demo | Empresa Vale, isolamento de outro cliente |
| Sem Empresa Demo | Estado de zero vínculos |
| Acesso Suspenso Demo | Estado negativo de conta suspensa |

Os estados/capacidades podem mudar pelos seus testes no painel. O arquivo de acessos reflete as senhas salvas na preparação; se você trocar uma senha pelo sistema, ela deve ser guardada por você. O helper não reseta senha/MFA nem ajusta permissões.

O acesso auxiliar **Ativação Local M10** também foi criado pelo painel para comprovar a ativação fake nova, com vínculo independente à Jardim. Cadastros fictícios de fases anteriores foram preservados.

## Roteiro de aceite pelo titular

1. Abrir a raiz em janela sem sessão. Entrar como Teste Local M10. Conferir que a lista contém somente Jardim e abrir seu atendimento.
2. Alterar roteiro, saudação ou horários; salvar rascunho e recarregar. Conferir versão salva e conteúdo. Salvar não publica nem ativa a empresa.
3. Entrar como Ana em outra janela e comparar Aurora/Horizonte. Trocar empresas durante edição; verificar que o conteúdo corresponde à empresa indicada. Conferir o estado sem empresas com a identidade apropriada.
4. Abrir o painel e autenticar com senha+MFA. Em **Empresas**, cadastrar outra empresa fictícia ou editar uma existente. Em **Onboarding**, revisar Empresa, Módulos, Atendimento, Menus, Operação e IA. Configurações técnicas ficam no painel.
5. Em **Acessos**, criar uma identidade com e-mail terminado em `.example`, escolher empresas/capacidades, revisar e confirmar. Ativar pelo link da caixa fictícia conforme abaixo. Cliente não cria empresa/equipe ou administra terceiros.
6. No Onboarding da Jardim, abrir **10. Revisão → Abrir simulador** e enviar “oi”. O simulador administrativo executa o runtime interno com efeitos sintéticos explicitamente identificados; não conversa com WhatsApp/OpenAI.
7. Conferir pendências em **Recalcular prontidão**. Sem conexões/chaves, publicar/ativar continuam bloqueados. A simulação/publicação do cliente também exige base técnica aprovada/empresa/prontidão: a capacidade sozinha não remove esses controles. A publicação bem-sucedida permanece comprovada pelas integrações controladas da M5–M9, e não por este dataset sem conexão.
8. Em Acessos, revogar sessões de Teste Local M10. Recarregar o portal: a sessão deve encerrar e o editor ficar vazio. Entrar novamente é permitido enquanto a identidade/vínculo estiver ativo. Testar suspensão/redução e restaurar pelo painel, sem SQL/restart.

Opcionais de cliente (conversas, fichas, mídia e ações humanas) permanecem fechados pela decisão da M7. A versão local permite testar o restante do produto dentro dessas permissões, sem declarar integração ou entrega externa.

## Ativação e recuperação fictícias

Depois de emitir ativação no painel ou solicitar recuperação no portal, aguardar a entrega fake (ciclo de até5s) e executar:

```powershell
rtk proxy node scripts/local-test-access.mjs mail
```

Abrir `.secrets/EMAILS_TESTE_LOCAL.md` e escolher o link do destinatário/finalidade desejados. Usar somente e-mails fictícios `.example`. A caixa é privada, sem rota HTTP pública. O helper só lê o container v2 confirmado e exporta links canônicos da origem5035; rejeita origem, destinatário ou payload inesperados.

Links são temporários e de uso único; reenvio invalida anteriores. Após reiniciar a API, a caixa fake em memória começa vazia: emitir novo link pelo produto. O banco/outbox e os acessos persistem. E-mail real/remetente/recepção externa ficam fora desta entrega local.

## Retomar depois de fechar o Docker

Abrir Docker Desktop e, no checkout WAIA/new, executar:

```powershell
rtk proxy node scripts/start-local-preview.mjs
```

O launcher lê `.secrets/v2-local-release.json`, confere Image ID/commit/versão e labels, verifica rede interna e os volumes existentes de PostgreSQL/Redis/mídia, inicia apenas os dois containers v2 existentes e recria somente API/proxy próprios. Ausência ou alvo divergente causa recusa, sem provisionar outro banco/volume, build, seed ou reset. Não usa Compose legado nem toca Filaretti/VPS.

O artefato exportado e manifesto ficam em `.tmp/releases/2.0.0-rc.2-<commit>/`. O arquivo de retomada aponta para o **mesmo Image ID** homologado; substituir uma tag mutável não muda essa identidade. Docker Desktop precisa estar disponível. Os comandos supõem as dependências locais já usadas pelo projeto; QR requer o pacote `qrcode` existente.

## Evidências e correções da fase

- Browser Edge/Playwright com APIs e persistência reais, sem `page.route`: login da raiz, senha+TOTP admin, cadastro/configuração/vínculo pelo painel, ativação fake com confirmação de senha/204, login cliente, salvar, isolamento404/admin401/403, revogação e simulador administrativo200. Capturas desktop1366/390/360; aceite humano registrado como pendente.
- O teste real descobriu preço decimal rejeitado pelo step inteiro padrão e modal com largura interna maior que a janela. Correções pequenas em `panel/onboarding.js`/`panel/styles.css`; browser confere validade/persistência149,90 e ausência de overflow do modal. Nenhuma alteração no CSS preexistente do portal.
- Seis testes do helper cobrem alvo incorreto, conta/origem externa, injeção, escopo dos dados exportados e vetor TOTP conhecido. Exportação usa arquivo atômico privado, ACL restrita no Windows antes de escrever conteúdo, sem valores no stdout.
- Node22 **704 casos: 674 aprovados, 30 skips opt-in, zero falhas**; **132 integrações PostgreSQL/Redis** aprovadas, sintaxe345 e auditoria0. Build/Compose e provas finais em `.tmp/m10/`. Os mesmos skips/exclusões históricos continuam explícitos. O teste de carga da M8 não foi repetido sem mudança no caminho de atendimento.
- Artefato novo do commit final com hashes dos arquivos/versão/assets, exportação e reload; RC1 preservada. Smoke, recuperação sintética e servidor final usam o Image ID entregue. A candidata não foi renomeada para estável.
- Revisões independentes de produto/exposição e operação incorporadas; preflight confere API/proxy/mídia antes de interromper qualquer superfície. Alterações preexistentes alheias preservadas.

## Encerramento do planejamento

**Implementação e entrega técnica local M0–M10 encerradas para teste do titular.** Pendência interna de aceite: executar o roteiro acima e registrar aprovação ou ajustes. Não existe fase adicional de implementação autorizada automaticamente. O aceite do titular não foi presumido.

Domínio/TLS/ingress efetivo, e-mail real, fornecedores/conexões, CI remota, observação operacional de sete dias e qualquer publicação permanecem fora do escopo local definido em25/10. Esses itens devem ser reavaliados em uma autorização de operação futura. VPS e empresas da instalação anterior continuam independentes. Após aceite funcional e definição dos gates de entrega final, gerar um novo artefato2.0.0 estável conforme o plano; mudar manifests exige outra build e prova, sem transformar a RC2 já homologada.
