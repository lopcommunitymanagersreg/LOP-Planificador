import { useEffect, useState } from 'react';
import { apiRequest } from './api.js';

export default function AuthScreen({ onAuthenticated }) {
  const [mode, setMode] = useState('login');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [methods, setMethods] = useState({ emailDelivery: false, google: false });
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [methodsError, setMethodsError] = useState('');

  useEffect(() => {
    const logoutNotice = window.sessionStorage.getItem('lop-logout-notice');
    if (logoutNotice) {
      setNotice(logoutNotice);
      window.sessionStorage.removeItem('lop-logout-notice');
    }
    apiRequest('/auth/methods')
      .then(setMethods)
      .catch((requestError) => setMethodsError(requestError.message));
    const query = new URLSearchParams(window.location.search);
    const authError = query.get('auth');
    if (authError) {
      setError(authError === 'google-unverified'
        ? 'Google no confirmó un correo verificado para esta cuenta.'
        : authError === 'google-conflict'
          ? 'Ese correo ya está vinculado a otra cuenta de Google.'
          : authError === 'google-link-required'
            ? 'Ya existe una cuenta con ese correo. Inicia sesión con correo y contraseña y vincula Google desde tu perfil.'
            : authError === 'google-link-session-required'
              ? 'La sesión venció durante la vinculación. Inicia sesión y vuelve a intentarlo.'
            : authError === 'google-config-error'
              ? 'Google rechazó la configuración OAuth. Verifica que el Client ID y el Client Secret correspondan al mismo cliente web.'
            : 'No se pudo completar el inicio de sesión oficial de Google.');
      window.history.replaceState({}, '', window.location.pathname);
    }
    if (query.get('connection') === 'facebook-error') {
      const reasons = {
        cancelled: 'Cancelaste la autorización de Facebook. Puedes iniciar sesión y volver a intentarlo.',
        'invalid-state': 'No se pudo validar el retorno de Facebook. Inicia sesión y vuelve a iniciar la conexión.',
        'state-expired': 'La autorización de Facebook venció. Inicia sesión y vuelve a iniciar la conexión.',
        'session-expired': 'La sesión local venció durante la autorización. Inicia sesión y vuelve a intentarlo.',
        'not-configured': 'La conexión requiere configurar las credenciales de Meta y la clave local de cifrado.',
        'permissions-missing': 'Meta no concedió todos los permisos solicitados para conectar páginas.',
        'no-manageable-pages': 'Meta autorizó la cuenta, pero no devolvió páginas administrables.',
        'provider-error': 'Meta rechazó o no pudo completar la conexión. El detalle se mostrará al iniciar sesión.',
      };
      setError(reasons[query.get('reason')] || 'No se pudo completar la conexión oficial de Facebook.');
    }
  }, []);

  const run = async (action, nextMode = null) => {
    setError('');
    setNotice('');
    setBusy(true);
    try {
      const result = await action();
      if (result?.user) await onAuthenticated(result.user);
      if (result?.message) setNotice(result.message);
      if (nextMode) {
        if (mode === 'register' || mode === 'reset') setPassword('');
        setMode(nextMode);
      }
      return result;
    } catch (requestError) {
      setError(requestError.message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const submitLogin = (event) => {
    event.preventDefault();
    run(() => apiRequest('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }));
  };

  const submitRegistration = (event) => {
    event.preventDefault();
    run(() => apiRequest('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ name, email, password }),
    }), 'verify');
  };

  const submitVerification = (event) => {
    event.preventDefault();
    run(() => apiRequest('/auth/verify-email', {
      method: 'POST',
      body: JSON.stringify({ email, code }),
    }));
  };

  const sendVerificationAgain = () => run(() => apiRequest('/auth/verification/send', {
    method: 'POST',
    body: JSON.stringify({ email }),
  }));

  const submitRecovery = (event) => {
    event.preventDefault();
    run(() => apiRequest('/auth/password/recovery', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }), 'reset');
  };

  const submitPasswordReset = (event) => {
    event.preventDefault();
    run(() => apiRequest('/auth/password/reset', {
      method: 'POST',
      body: JSON.stringify({ email, code, password }),
    }), 'login');
  };

  const isRegister = mode === 'register';
  const isVerify = mode === 'verify';
  const isRecovery = mode === 'recovery';
  const isReset = mode === 'reset';
  const isEmailCodeFlow = isVerify || isReset;
  const title = isRegister
    ? 'Crear cuenta'
    : isVerify
      ? 'Verifica tu correo'
      : isRecovery
        ? 'Recuperar contraseña'
        : isReset
          ? 'Establece una contraseña nueva'
          : 'Inicia sesión';
  const description = isRegister
    ? 'Crea tu cuenta. Te enviaremos un código real para confirmar tu correo.'
    : isVerify
      ? `Enviamos un código a ${email}. Caduca en 10 minutos.`
      : isRecovery
        ? 'Te enviaremos un código de un solo uso al correo de tu cuenta.'
        : isReset
          ? 'Escribe el código enviado a tu correo y tu nueva contraseña.'
          : 'Accede a tu espacio y a tus borradores guardados en este equipo.';

  const submit = isRegister ? submitRegistration
    : isVerify ? submitVerification
      : isRecovery ? submitRecovery
        : isReset ? submitPasswordReset : submitLogin;

  return (
    <main className="auth-page">
      <section className="auth-card" aria-labelledby="auth-title">
        <div className="auth-brand" aria-label="LOP Planificador">
          <span className="brand-mark">L</span>
          <span className="brand-copy"><strong>LOP</strong><small>PLANIFICADOR</small></span>
        </div>
        <p className="eyebrow">{isEmailCodeFlow ? 'SEGURIDAD DEL CORREO' : 'ESPACIO PERSONAL'}</p>
        <h1 id="auth-title">{title}</h1>
        <p className="auth-description">{description}</p>

        {methodsError && <p className="auth-error" role="alert">{methodsError}</p>}
        {error && <p className="auth-error" role="alert">{error}</p>}
        {notice && <p className="auth-success" role="status">{notice}</p>}

        {isVerify && (
          <form className="auth-form" onSubmit={submit}>
            <label className="field-label" htmlFor="verify-code">Código de seis dígitos</label>
            <input id="verify-code" autoComplete="one-time-code" inputMode="numeric" maxLength="6" onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} pattern="\d{6}" required value={code} />
            <button className="primary-button auth-submit" disabled={busy} type="submit">{busy ? 'Verificando…' : 'Verificar correo'}</button>
            <button className="auth-text-button" disabled={busy} onClick={sendVerificationAgain} type="button">Enviar otro código</button>
          </form>
        )}

        {isRecovery && (
          <form className="auth-form" onSubmit={submit}>
            <label className="field-label" htmlFor="recovery-email">Correo electrónico</label>
            <input id="recovery-email" autoComplete="email" maxLength="254" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
            <button className="primary-button auth-submit" disabled={busy || !methods.emailDelivery} type="submit">{busy ? 'Enviando…' : 'Enviar código'}</button>
            {!methods.emailDelivery && <p className="auth-hint">Configura SMTP para habilitar el envío real de correo.</p>}
          </form>
        )}

        {(isRegister || isReset || mode === 'login') && (
          <form className="auth-form" onSubmit={submit}>
            {isRegister && (
              <>
                <label className="field-label" htmlFor="auth-name">Nombre</label>
                <input id="auth-name" autoComplete="name" maxLength="80" onChange={(event) => setName(event.target.value)} required value={name} />
              </>
            )}
            <label className="field-label" htmlFor="auth-email">Correo electrónico</label>
            <input id="auth-email" autoComplete="email" maxLength="254" onChange={(event) => setEmail(event.target.value)} required type="email" value={email} />
            {isReset && (
              <>
                <label className="field-label" htmlFor="reset-code">Código de seis dígitos</label>
                <input id="reset-code" autoComplete="one-time-code" inputMode="numeric" maxLength="6" onChange={(event) => setCode(event.target.value.replace(/\D/g, ''))} pattern="\d{6}" required value={code} />
              </>
            )}
            <label className="field-label" htmlFor="auth-password">{isReset ? 'Nueva contraseña' : 'Contraseña'}</label>
            <input
              id="auth-password"
              autoComplete={isRegister || isReset ? 'new-password' : 'current-password'}
              maxLength="128"
              minLength={isRegister || isReset ? 12 : undefined}
              onChange={(event) => setPassword(event.target.value)}
              required
              type="password"
              value={password}
            />
            {(isRegister || isReset) && <p className="auth-hint">Usa al menos 12 caracteres.</p>}
            <button className="primary-button auth-submit" disabled={busy || (isRegister && !methods.emailDelivery)} type="submit">
              {busy ? 'Un momento…' : isRegister ? 'Crear cuenta' : isReset ? 'Cambiar contraseña' : 'Iniciar sesión'}
            </button>
            {isRegister && !methods.emailDelivery && <p className="auth-hint">El registro requiere SMTP configurado para enviar el código de verificación.</p>}
          </form>
        )}

        {mode === 'login' && methods.google && (
          <a className="google-auth-button" href="/api/auth/google">
            <GoogleMark />
            Continuar con Google
          </a>
        )}

        {mode === 'login' && methods.emailDelivery && (
          <button className="auth-text-button auth-recovery-link" onClick={() => { setMode('recovery'); setPassword(''); setError(''); setNotice(''); }} type="button">
            ¿Olvidaste tu contraseña?
          </button>
        )}

        {!methods.emailDelivery && mode === 'login' && (
          <p className="auth-local-note">El envío de verificación y recuperación no está configurado. Google aparece únicamente si se configura OAuth oficial.</p>
        )}
        {!methods.google && !methodsError && mode === 'login' && (
          <p className="auth-hint auth-provider-note">El inicio con Google estará disponible al configurar credenciales OAuth oficiales.</p>
        )}

        {(mode === 'register' || isRecovery || isReset) && (
          <p className="auth-switch">
            {isRecovery || isReset ? '¿Recordaste tu contraseña?' : isRegister ? '¿Ya tienes una cuenta?' : '¿Primera vez en LOP?'}{' '}
            <button onClick={() => { setMode('login'); setPassword(''); setCode(''); setError(''); setNotice(''); }} type="button">
              Iniciar sesión
            </button>
          </p>
        )}
        {mode === 'login' && (
          <p className="auth-switch">
            ¿Primera vez en LOP?{' '}
            <button disabled={!methods.emailDelivery} onClick={() => { setMode('register'); setError(''); setNotice(''); }} type="button">
              Crear cuenta con correo
            </button>
          </p>
        )}
        {isVerify && (
          <p className="auth-switch">
            <button onClick={() => { setMode('login'); setCode(''); setError(''); setNotice(''); }} type="button">Volver al inicio de sesión</button>
          </p>
        )}
        <p className="auth-local-note">No hay autenticaciones simuladas. Los servicios de correo y Google solo se muestran activos cuando se configuran credenciales reales.</p>
      </section>
    </main>
  );
}

function GoogleMark() {
  return <svg aria-hidden="true" className="google-mark" viewBox="0 0 48 48"><path fill="#4285F4" d="M43.6 24.5c0-1.4-.1-2.8-.4-4.1H24v7.8h11a9.4 9.4 0 0 1-4.1 6.2v5.1h6.6c3.9-3.6 6.1-8.8 6.1-15Z" /><path fill="#34A853" d="M24 44c5.5 0 10.1-1.8 13.5-4.8l-6.6-5.1c-1.8 1.2-4.1 2-6.9 2-5.3 0-9.8-3.6-11.4-8.4H5.8v5.3A20 20 0 0 0 24 44Z" /><path fill="#FBBC05" d="M12.6 27.7a12 12 0 0 1 0-7.4V15H5.8a20 20 0 0 0 0 18Z" /><path fill="#EA4335" d="M24 11.9c3 0 5.7 1 7.8 3.1l5.8-5.8A19.5 19.5 0 0 0 24 4 20 20 0 0 0 5.8 15l6.8 5.3c1.6-4.8 6.1-8.4 11.4-8.4Z" /></svg>;
}
