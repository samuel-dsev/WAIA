# Transcrição de áudio — candidata local 1.30.0

Pedido autorizado em 25/11/2026. Base conferida no Git, no relatório compartilhado e no encerramento do outro chat: linha estável `dev`, commit `b1b8223`, versão 1.29.2 publicada. Implementação no checkout principal WAIA; a candidata 2.0/`new` permanece separada.

## Plano simples executado

1. Adicionar uma opção de transcrição no onboarding para qualquer empresa com IA OpenAI, desativada por padrão.
2. Processar a mídia privada com duração medida, reserva mensal e proteção contra cobrança duplicada.
3. Exibir o texto no painel e utilizá-lo como fala do cliente no atendimento, histórico, evidências de triagem e contexto de follow-up.

## Ativação e comportamento

- No onboarding da empresa, etapa **IA**, marcar **Transcrever áudios e responder com IA**; salvar, validar e publicar a configuração pelo fluxo existente.
- Usa a chave OpenAI própria/compartilhada já selecionada para a IA. Não exige catálogo, avaliação de veículos, qualificação de leads ou um ramo específico.
- Limite fixo de **1.800 segundos (30 minutos) por empresa por mês**, compartilhado por todos os seus números e chats. Renova no primeiro dia, à meia-noite no fuso da empresa, sem acumular saldo. Cada áudio é arredondado para o próximo segundo.
- O onboarding mostra tempo utilizado e reservado do mês corrente. Desmarcar remove o campo do rascunho; a mudança só afeta o runtime depois de publicar.
- Processa entradas novas na fila normal enquanto bot, empresa, contato e canal estão disponíveis. Conversas pausadas, com posse humana, bloqueadas, excluídas, consentimento revogado ou conteúdo expirado não iniciam transcrição. Não reprocessa histórico antigo nem reabre conversas.
- O áudio continua sendo a mesma mensagem recebida, com o mesmo ID, tipo e sequência. O texto aparece em **Transcrição do áudio**, no histórico do painel, como texto literal seguro.
- A IA usa a transcrição na ordem das mensagens, inclusive em turnos com texto e áudio. Não há uma segunda entrada artificial, mensagem automática de confirmação ou reinício de follow-up. Novas mensagens durante a transcrição entram no próximo agrupamento antes da chamada da IA de atendimento.
- As respostas, dúvidas, coleta de nome e finalização seguem o roteiro publicado e as validações da 1.29.2. O timer de 15 minutos da pergunta final de nome e a política de follow-up permanecem os mesmos.

## Mídia, processamento e consumo

- Download autenticado pela conexão Meta/YCloud da própria empresa. A referência YCloud de áudio é preservada no webhook assinado; OGG com `codecs=opus` é normalizado, mantendo conferência de WABA, URL, MIME, tamanho e hash.
- Até 10 MiB por arquivo; OGG/Opus, MP3, MP4/M4A de áudio, WAV, WebM e FLAC. O formato e a duração são lidos dos bytes com `music-metadata` 11.16.1, já presente no lockfile e agora dependência direta. Sem nova ferramenta de sistema ou conversão de arquivo.
- Não envia à OpenAI áudio sem duração válida, maior que 30 minutos, de formato não aceito ou que não caiba integralmente no saldo disponível. Sem corte silencioso ou transcrição parcial por falta de saldo.
- Chama `POST /v1/audio/transcriptions`, modelo `gpt-transcribe`, saída JSON no idioma original, sem resumo. O SDK tem timeout de 90 segundos e retries automáticos desativados. Texto vazio, com caracteres inválidos ou acima de 8.000 caracteres não entra na IA de atendimento; o cliente recebe orientação para escrever.
- PostgreSQL reserva o tempo antes do POST. Conta da empresa, reserva da mensagem e início da tentativa são protegidos por transação, locks e unicidade. Duas conversas não conseguem gastar o mesmo saldo, nem duas execuções iniciar o mesmo áudio.
- Reservas abandonadas antes do POST expiram em dois minutos e são liberadas no próximo processamento elegível; cancelamento antes do início libera o saldo. Reserva que atravessa o fim do mês é cancelada, sem transferir consumo para o mês seguinte.
- Uma tentativa marcada como iniciada não é enviada novamente automaticamente. Depois de crash/timeout sem confirmação, o estado é `uncertain`; o tempo permanece contado de forma conservadora. Falhas depois do início também contam nesse controle, que não é uma fatura do provedor. Repetir o job reutiliza o resultado persistido ou a mesma pendência.
- A contabilização de duração, modelo, custo estimado, período, configuração e estado fica separada dos tokens das respostas da IA. A tarifa consultada em 25/11/2026 é US$ 0,0045/minuto: 30 minutos correspondem a US$ 0,135 de transcrição; as respostas em texto continuam com seu consumo normal. Fonte: [modelo e preço oficiais](https://developers.openai.com/api/docs/models/gpt-transcribe); [contrato de transcrição](https://developers.openai.com/api/docs/guides/speech-to-text).
- Ao esgotar o saldo ou não conseguir transcrever, pede mensagem por texto. Texto válido no mesmo turno continua sendo respondido. O painel diferencia processamento, falha, formato não aceito, ausência de fala, limite atingido e resultado incerto.

## Dados e limites operacionais

- Migração aditiva `063_audio_transcription.sql`: campos na mensagem original e tabelas `audio_quota_accounts`/`audio_transcription_usage`, com isolamento RLS por empresa.
- A transcrição segue as mesmas permissões do histórico. Texto, áudio e credenciais não entram em logs de erro. A API de consumo é administrativa e somente de leitura.
- Exclusão do contato e retenção apagam o texto transcrito. O áudio usa o armazenamento privado e a limpeza de mídias existente. O consumo e os estados técnicos sem texto permanecem contabilizados, sem permitir apagar o contato para recuperar a quota.
- Revalidação antes de iniciar e persistir bloqueia resultado tardio após pausa, exclusão ou troca de configuração. Antes do envio, uma configuração de áudio desativada também cancela a resposta preparada daquele turno.
- Nenhuma empresa ou credencial de produção foi alterada para ativar a capacidade. Não houve transcrição externa paga nem mensagem WhatsApp real nesta validação; contrato e fluxos externos foram simulados. Isso não comprova qualidade de reconhecimento nem entrega real do provedor.

## Casos verificados

- Áudio sozinho; voz seguida de texto; nome, cidade e pergunta no mesmo áudio; relato anterior em voz mantido nas evidências da triagem.
- Texto recebido durante a transcrição; repetição do webhook/job; resposta persistida reaproveitada; tentativa externa incerta sem nova cobrança automática.
- Duas conversas concorrentes; saldo exatamente no limite; empresa distinta com saldo próprio; renovação mensal no fuso de São Paulo; cancelamento de reserva na mudança de mês e recuperação de reservas abandonadas.
- Formato/MIME divergente, arquivo curto, duração excessiva, voz OGG/Opus e WAV; erro HTTP, timeout e retorno sem fala; instruções indevidas filtradas no histórico.
- Pausa, bloqueio, revogação de consentimento, expiração, exclusão e desativação da capacidade. Texto tardio não é salvo após exclusão; consumo de chamada iniciada não é devolvido indevidamente.
- Painel mostra texto com HTML como conteúdo literal. Histórico, consumo e mensagem original conferidos no PostgreSQL. Regressões da triagem sem nome, ficha de lead, follow-up e espera/envio incluídas.

Validação final: **811 aprovados/34 condicionais/zero falhas** tanto no Node local quanto no Node 22 com a fonte montada na imagem estável existente; **47 testes PostgreSQL reais aprovados** (35 de áudio/triagem/follow-up/envio e 12 de fotos) no banco isolado `waia_v2_upgrade` de `waia-test`, com comparação de contagens/hashes das 142 tabelas e contêiner devolvido parado. A suíte de áudio foi reexecutada para conferir também o armazenamento de metadados e a retenção. Isso valida a candidata montada; ainda não é uma imagem nova publicada. Evidências locais em `.tmp/audio-transcription/` e `.tmp/audio-transcription-unit.tap`.

## Arquivos para revisão do commit

- Versão: `package.json`, `package-lock.json`.
- Banco e áudio: `db/migrations/063_audio_transcription.sql`, `src/modules/audio/audio-policy.js`, `src/modules/audio/audio-service.js`, `src/modules/audio/postgres-audio-repository.js`.
- Execução e conectores: `src/bootstrap/app-runtime.js`, `src/modules/jobs/handlers.js`, `src/modules/jobs/inbound-turn.js`, `src/modules/jobs/reply-batch.js`, `src/modules/meta/ycloud-webhook-service.js`, `src/integrations/ycloud/media-reference.js`.
- Configuração/IA: `src/modules/configuration/tenant-runtime-config-v2.js`, `src/modules/configuration/legacy-adapter.js`, `src/modules/ai/contracts.js`, `src/modules/ai/postgres-adapters.js`, `src/modules/ai/ai-service.js`, `src/modules/ai/inbound-content.js`, `src/modules/ai/conversation-context.js`.
- Histórico, permissões e contexto: `src/modules/conversations/postgres-conversation-repository.js`, `src/modules/admin/postgres-admin-repository.js`, `src/modules/admin/resources.js`, `src/modules/follow-up/repository.js`.
- Painel: `panel/app.js`, `panel/onboarding.js`.
- Testes: `test/audio-transcription.test.js`, `test/audio-transcription-postgres.test.js`, `test/ai-multitenant.test.js`, `test/ycloud-media.test.js`.
- Documentação: este arquivo, sua exceção em `.gitignore`, entrada da candidata em `PLAN.md` e em `RELATORIO.md`.

As alterações anteriores de `.gitignore` (exceção da publicação 1.29.2), `docs/CONTINUIDADE_ATENDIMENTO_1.29.2.md`, `docs/DEPLOY_1.29.2.md`, `infra/postgres/init-v2-test.sh` e os artefatos locais são preservadas e ficam fora do escopo do commit de áudio. As entradas de publicação da 1.29.2 já presentes em PLAN/RELATORIO também são preservadas; separar esses trechos ao preparar o commit.

Mensagem proposta: **v1.30.0 - adiciona transcricao de audio com quota mensal por empresa**. Commit/push exigem confirmação explícita conforme AGENTS.md; promoção de main e deploy dependem de autorização específica.

Revisão local pronta: `.tmp/audio-transcription/review-1.30.0.patch` reúne os 33 arquivos, incluindo apenas os trechos de áudio nos arquivos compartilhados. Patch verificado contra o HEAD, sem stage/commit. Pacote `.tmp/audio-transcription/runtime-1.30.0/` com 258 arquivos de runtime e hashes conferidos com a fonte, sem fixtures locais. Metadados sanitizados em `.tmp/audio-transcription/validation.json`.

## Publicação e retorno

Ainda não publicado. Após autorização própria, seguir `docs/OPERACAO_RELEASE.md`, validar a imagem da candidata e aplicar a migração aditiva antes do worker. A ativação de cada empresa ocorre pelo onboarding, sem SQL, `.env` ou reinício por tenant.

Para voltar a uma imagem anterior após usar a função, desmarcar a opção e publicar enquanto a 1.30.0 ainda está ativa: o onboarding remove o campo novo, permitindo leitura pela 1.29.2. Conferir o encerramento das respostas de áudio pendentes antes de trocar o runtime. Manter os campos/tabelas e o consumo; não executar migração destrutiva para rollback.
