export function installSecurity({ $, account, home, show, notice, form, getUser, onLogin,
  isCurrent = () => true, beforeOpen = () => true, onOpen = () => {} }) {
  let epoch = 0;
  let challenge = null;
  let mode = 'login';

  const clearSecrets = () => {
    challenge = null;
    $('mfa-secret').textContent = '';
    $('recovery-codes').textContent = '';
    for (const id of ['mfa', 'mfa-setup', 'reauth', 'mfa-disable-form']) $(id).reset();
  };
  const current = () => {
    const version = epoch;
    const userId = getUser()?.id;
    return () => version === epoch && userId === getUser()?.id && isCurrent();
  };
  const guarded = (action) => async (...args) => {
    const valid = current();
    try { await action(valid, ...args); }
    catch (error) { if (valid()) throw error; }
  };
  const click = (id, action) => {
    $(id).addEventListener('click', async () => {
      const button = $(id);
      button.disabled = true;
      notice();
      try { await guarded(action)(); }
      catch (error) { notice(error.message, true); }
      finally { button.disabled = false; }
    });
  };

  function showChallenge(result, purpose = 'login') {
    epoch++;
    clearSecrets();
    challenge = result.challenge;
    mode = purpose;
    $('mfa-secret').textContent = result.enrollment
      ? `Adicione esta chave ao seu aplicativo autenticador (TOTP):\n${result.enrollment.secret}` : '';
    $('mfa-hint').textContent = result.enrollment
      ? 'Confirme o código do aplicativo para concluir a ativação.'
      : 'Informe o código do autenticador ou um código de recuperação.';
    show('mfa');
  }

  async function codesOrHome(result) {
    if (result.recoveryCodes?.length) {
      $('recovery-codes').textContent = result.recoveryCodes.join('\n');
      show('recovery');
    } else await home();
  }

  form('mfa', guarded(async (valid, { code }) => {
    if (!challenge) throw new Error('Inicie o acesso novamente para obter um novo código.');
    const purpose = mode;
    const result = await account(purpose === 'login' ? 'mfa/login' : 'mfa/confirm', { challenge, code });
    if (!valid()) return;
    clearSecrets();
    if (purpose === 'login') onLogin(result);
    await codesOrHome(result);
  }));

  click('recovery-done', async () => {
    epoch++;
    clearSecrets();
    await home();
  });

  async function security() {
    epoch++;
    clearSecrets();
    const valid = current();
    $('session-list').replaceChildren();
    try {
      const { sessions } = await account('sessions', null, 'GET');
      if (!valid()) return;
      for (const session of sessions) {
        const item = document.createElement('div');
        item.className = 'company';
        const info = document.createElement('p');
        info.textContent = `${session.current ? 'Esta sessão' : 'Outra sessão'} · ${session.audience === 'admin' ? 'Painel' : 'Portal'} · acesso ${new Date(session.lastSeenAt).toLocaleString('pt-BR')}`;
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.textContent = 'Encerrar sessão';
        revoke.addEventListener('click', async () => {
          if (!valid()) return;
          revoke.disabled = true;
          notice();
          try {
            await account(`sessions/${encodeURIComponent(session.id)}`, null, 'DELETE');
            if (!valid()) return;
            if (session.current) await home();
            else await security();
          } catch (error) { if (valid()) notice(error.message, true); }
          finally { revoke.disabled = false; }
        });
        item.append(info, revoke);
        $('session-list').append(item);
      }
      $('mfa-setup').hidden = getUser()?.mfaEnabled === true;
      $('mfa-controls').hidden = !getUser()?.mfaEnabled;
      show('security');
    } catch (error) { if (valid()) notice(error.message, true); }
  }

  click('security-open', async () => {
    if (!beforeOpen()) return;
    onOpen();
    await security();
  });
  form('mfa-setup', guarded(async (valid, { password }) => {
    const result = await account('mfa/setup', { password });
    if (!valid()) return;
    $('mfa-setup').reset();
    showChallenge(result, 'enroll');
  }));
  form('reauth', guarded(async (valid, data) => {
    await account('reauthenticate', data);
    if (!valid()) return;
    $('reauth').reset();
    notice('Identidade confirmada por dez minutos.');
  }));
  click('mfa-regenerate', async (valid) => {
    const result = await account('mfa/recovery', {});
    if (valid()) await codesOrHome(result);
  });
  form('mfa-disable-form', guarded(async (valid) => {
    await account('mfa/disable', {});
    if (!valid()) return;
    epoch++;
    clearSecrets();
    await home();
  }));
  function clear() {
    epoch++;
    clearSecrets();
    $('session-list').replaceChildren();
  }
  return { showChallenge, clear };
}
