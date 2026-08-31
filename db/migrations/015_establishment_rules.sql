ALTER TABLE configuracoes_empresa
  ADD COLUMN regras_estabelecimento text NOT NULL DEFAULT '';

UPDATE configuracoes_empresa
SET regras_estabelecimento = E'Vestimenta: não é permitida a entrada usando boné, regata, corrente de prata ou camisa de time de futebol.\n\nAniversariante: o aniversariante do mês tem entrada VIP. Se levar até 10 convidados, também terá direito a um acompanhante VIP. Caso contrário, somente o aniversariante terá entrada VIP.',
    regra_aniversariante = 'O aniversariante do mês tem entrada VIP. Se levar até 10 convidados, também terá direito a um acompanhante VIP. Caso contrário, somente o aniversariante terá entrada VIP.',
    updated_at = now()
WHERE empresa_id = '00000000-0000-4000-8000-000000000001'
  AND regras_estabelecimento = '';

UPDATE empresas
SET versao_configuracao = versao_configuracao + 1,
    updated_at = now()
WHERE id = '00000000-0000-4000-8000-000000000001';
