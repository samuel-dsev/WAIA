-- Dados exclusivamente públicos e sintéticos para validar o primeiro tenant.
-- Não contém número WhatsApp, chave PIX real, credencial, senha ou dado pessoal.
SELECT set_config('app.empresa_id', '', true);
SELECT set_config('app.usuario_id', '', true);
SELECT set_config('app.is_platform_admin', 'true', true);

INSERT INTO configuracoes_empresa (
  empresa_id, saudacao, mensagem_fallback, endereco, link_cardapio,
  regra_aniversariante, respostas_publicas, roteamento
)
VALUES (
  '00000000-0000-4000-8000-000000000001',
  'Olá! Bem-vindo ao Bar Capitão Mor. Como podemos ajudar?',
  'Consigo ajudar apenas com informações validadas desta empresa. Consulte o menu ou fale com a equipe.',
  'Rua Demonstração, 100 — Centro',
  'https://example.invalid/capitao-mor/cardapio',
  'Consulte elegibilidade e disponibilidade com a equipe; nenhum benefício é confirmado automaticamente.',
  '[{"module":"catalog","action":"catalog.address","text":"Endereço demonstrativo: Rua Demonstração, 100 — Centro."},{"module":"catalog","action":"catalog.menu","text":"Cardápio demonstrativo: https://example.invalid/capitao-mor/cardapio"},{"module":"events","action":"events.birthday_rule","text":"Regra demonstrativa: consulte a equipe; nenhum benefício é automático."}]'::jsonb,
  '{"greetings":["oi","olá","bom dia","boa tarde","boa noite"],"fallbackAction":"ai_freeform.reply"}'::jsonb
)
ON CONFLICT (empresa_id) DO NOTHING;

UPDATE menu_itens
SET action_key = CASE id
  WHEN '00000000-0000-4000-8000-000000000011'::uuid THEN 'orders.start'
  WHEN '00000000-0000-4000-8000-000000000012'::uuid THEN 'catalog.address'
  WHEN '00000000-0000-4000-8000-000000000013'::uuid THEN 'catalog.menu'
END,
updated_at = now()
WHERE empresa_id = '00000000-0000-4000-8000-000000000001'
  AND (
    (id = '00000000-0000-4000-8000-000000000011' AND action_key = 'comprar_convites')
    OR (id = '00000000-0000-4000-8000-000000000012' AND action_key = 'consultar_endereco')
    OR (id = '00000000-0000-4000-8000-000000000013' AND action_key = 'consultar_cardapio')
  );

INSERT INTO produtos_servicos (
  id, empresa_id, tipo, sku, nome, descricao, preco, moeda,
  controle_estoque, quantidade_disponivel, ativo
)
VALUES
  (
    '00000000-0000-4000-8000-000000000030',
    '00000000-0000-4000-8000-000000000001',
    'convite',
    'DEMO-SEXTA',
    'Convite Sexta Rock Demo',
    'Produto demonstrativo sem validade comercial.',
    25.00,
    'BRL',
    'sob_consulta',
    NULL,
    true
  ),
  (
    '00000000-0000-4000-8000-000000000031',
    '00000000-0000-4000-8000-000000000001',
    'convite',
    'DEMO-SABADO',
    'Convite Sábado Acústico Demo',
    'Produto demonstrativo sem validade comercial.',
    20.00,
    'BRL',
    'sob_consulta',
    NULL,
    true
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO eventos (
  id, empresa_id, origem_externa, external_id, nome, atracoes,
  inicio_at, fim_at, timezone, local, regra_vip, observacoes, status
)
VALUES
  (
    '00000000-0000-4000-8000-000000000040',
    '00000000-0000-4000-8000-000000000001',
    'seed_demo',
    'evento-demo-sexta',
    'Sexta Rock Demo',
    'Atração demonstrativa',
    '2099-01-09T22:00:00-03:00',
    '2099-01-10T02:00:00-03:00',
    'America/Sao_Paulo',
    'Rua Demonstração, 100 — Centro',
    'Aniversariante deve consultar elegibilidade e disponibilidade com a equipe.',
    'Evento sintético sem validade comercial.',
    'publicado'
  ),
  (
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000001',
    'seed_demo',
    'evento-demo-sabado',
    'Sábado Acústico Demo',
    'Atração demonstrativa',
    '2099-01-10T20:00:00-03:00',
    '2099-01-11T00:00:00-03:00',
    'America/Sao_Paulo',
    'Rua Demonstração, 100 — Centro',
    'Aniversariante deve consultar elegibilidade e disponibilidade com a equipe.',
    'Evento sintético sem validade comercial.',
    'publicado'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO eventos_produtos (empresa_id, evento_id, produto_servico_id)
VALUES
  (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000040',
    '00000000-0000-4000-8000-000000000030'
  ),
  (
    '00000000-0000-4000-8000-000000000001',
    '00000000-0000-4000-8000-000000000041',
    '00000000-0000-4000-8000-000000000031'
  )
ON CONFLICT (empresa_id, evento_id, produto_servico_id) DO NOTHING;

INSERT INTO formas_pagamento (
  id, empresa_id, tipo, nome, identificador_mascarado,
  favorecido, instrucoes, ativa
)
VALUES (
  '00000000-0000-4000-8000-000000000020',
  '00000000-0000-4000-8000-000000000001',
  'pix',
  'PIX demonstrativo',
  '••••@exemplo.invalid',
  'Capitão Mor Demonstração',
  'Forma de pagamento exclusivamente sintética; exige conferência humana.',
  true
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO integracoes (
  id, empresa_id, tipo, nome, habilitada,
  obrigatoria_para_confirmacao, status, configuracao
)
VALUES (
  '00000000-0000-4000-8000-000000000050',
  '00000000-0000-4000-8000-000000000001',
  'google_sheets',
  'Google Sheets demonstrativo',
  false,
  true,
  'nao_configurada',
  '{"mode":"demo","source":"synthetic"}'::jsonb
)
ON CONFLICT (id) DO NOTHING;
