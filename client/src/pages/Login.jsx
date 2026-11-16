import { useEffect, useState } from 'react';
import {
  Button,
  Card,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Text,
  Link,
  makeStyles,
  mergeClasses,
  tokens,
} from '@fluentui/react-components';
import { Backspace24Regular } from '@fluentui/react-icons';
import { useApp } from '../data/AppData.jsx';
import { ApiError, NetworkError } from '../lib/api.js';

const useStyles = makeStyles({
  wrap: {
    minHeight: '100dvh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    boxSizing: 'border-box',
  },
  card: { width: '100%', maxWidth: '420px', padding: tokens.spacingHorizontalXXL, gap: tokens.spacingVerticalL },
  signin: { width: '100%', maxWidth: '320px', display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  switchMode: { alignSelf: 'center', fontSize: tokens.fontSizeBase300 },
  center: { textAlign: 'center' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  dots: { display: 'flex', justifyContent: 'center', gap: tokens.spacingHorizontalM, marginBlock: tokens.spacingVerticalM },
  dot: {
    width: '18px',
    height: '18px',
    borderRadius: '50%',
    border: `2px solid ${tokens.colorNeutralStroke1}`,
    boxSizing: 'border-box',
  },
  dotOn: { backgroundColor: tokens.colorBrandBackground, borderColor: tokens.colorBrandBackground },
  pad: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: tokens.spacingHorizontalM },
  key: { height: '68px', fontSize: tokens.fontSizeBase600 },
});

function errorText(e) {
  if (e instanceof NetworkError) return 'Can’t reach the chores server. Check the Wi-Fi.';
  return e?.message ?? 'Something went wrong';
}

function PinPad() {
  const s = useStyles();
  const { signIn } = useApp();
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [waitUntil, setWaitUntil] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    if (waitUntil <= Date.now()) return undefined;
    const id = setInterval(() => tick((n) => n + 1), 500);
    return () => clearInterval(id);
  }, [waitUntil]);
  const waitSecs = Math.max(0, Math.ceil((waitUntil - Date.now()) / 1000));

  async function submit(code) {
    setBusy(true);
    setError(null);
    try {
      await signIn('/api/auth/pin', { pin: code });
    } catch (e) {
      setPin('');
      setError(errorText(e));
      if (e instanceof ApiError && e.retryAfterMs) setWaitUntil(Date.now() + e.retryAfterMs);
    } finally {
      setBusy(false);
    }
  }

  const press = (d) => {
    if (busy || waitSecs > 0 || pin.length >= 6) return;
    const next = pin + d;
    setPin(next);
    if (next.length === 6) submit(next);
  };

  return (
    <div className={s.form}>
      <div className={s.dots} role="img" aria-label={`PIN: ${pin.length} of 6 digits entered`}>
        {Array.from({ length: 6 }, (_, i) => (
          <span key={i} className={mergeClasses(s.dot, i < pin.length && s.dotOn)} />
        ))}
      </div>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{waitSecs > 0 ? `Too many wrong tries. Try again in ${waitSecs}s.` : error}</MessageBarBody>
        </MessageBar>
      )}
      <div className={s.pad}>
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Button key={d} className={s.key} disabled={busy || waitSecs > 0} onClick={() => press(d)}>{d}</Button>
        ))}
        <span />
        <Button className={s.key} disabled={busy || waitSecs > 0} onClick={() => press('0')}>0</Button>
        <Button className={s.key} appearance="subtle" icon={<Backspace24Regular />} aria-label="Delete" disabled={busy || !pin} onClick={() => setPin(pin.slice(0, -1))} />
      </div>
    </div>
  );
}

function PasswordForm() {
  const s = useStyles();
  const { signIn } = useApp();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn('/api/auth/login', { username: username.trim(), password });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.form} onSubmit={submit}>
      <Field label="Username">
        <Input size="large" value={username} onChange={(_, d) => setUsername(d.value)} autoCapitalize="none" autoCorrect="off" autoComplete="username" required />
      </Field>
      <Field label="Password">
        <Input size="large" type="password" value={password} onChange={(_, d) => setPassword(d.value)} autoComplete="current-password" required />
      </Field>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <Button size="large" appearance="primary" type="submit" disabled={busy || !username || !password}>Sign in</Button>
    </form>
  );
}

function FirstRun() {
  const s = useStyles();
  const { signIn } = useApp();
  const [f, setF] = useState({ nickname: '', username: '', birthDate: '', password: '', confirm: '' });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (_, d) => setF({ ...f, [k]: d.value });

  async function submit(e) {
    e.preventDefault();
    if (f.password !== f.confirm) return setError('The passwords don’t match');
    setBusy(true);
    setError(null);
    try {
      await signIn('/api/auth/setup', { nickname: f.nickname, username: f.username.trim(), birthDate: f.birthDate, password: f.password });
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className={s.form} onSubmit={submit}>
      <Text>Create the first grown-up account. You can add everyone else after signing in.</Text>
      <Field label="Name shown in the app" required><Input size="large" value={f.nickname} onChange={set('nickname')} /></Field>
      <Field label="Username" required hint="Letters, numbers, dots or dashes">
        <Input size="large" value={f.username} onChange={set('username')} autoCapitalize="none" autoCorrect="off" />
      </Field>
      <Field label="Birth date" required><Input size="large" type="date" value={f.birthDate} onChange={set('birthDate')} /></Field>
      <Field label="Password" required hint="At least 6 characters">
        <Input size="large" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
      </Field>
      <Field label="Password again" required>
        <Input size="large" type="password" value={f.confirm} onChange={set('confirm')} autoComplete="new-password" />
      </Field>
      {error && (
        <MessageBar intent="error">
          <MessageBarBody>{error}</MessageBarBody>
        </MessageBar>
      )}
      <Button size="large" appearance="primary" type="submit" disabled={busy}>Create account</Button>
    </form>
  );
}

export function Login({ setup = false }) {
  const s = useStyles();
  const [mode, setMode] = useState('pin');
  if (setup) {
    return (
      <div className={s.wrap}>
        <Card className={s.card} size="large"><FirstRun /></Card>
      </div>
    );
  }
  // Just the PIN keypad; password sign-in is a quiet link underneath.
  return (
    <div className={s.wrap}>
      <div className={s.signin}>
        {mode === 'pin' ? <PinPad /> : <PasswordForm />}
        <Link className={s.switchMode} onClick={() => setMode(mode === 'pin' ? 'password' : 'pin')}>
          {mode === 'pin' ? 'Use username and password' : 'Use PIN'}
        </Link>
      </div>
    </div>
  );
}

export function Unreachable() {
  const s = useStyles();
  const { refresh } = useApp();
  return (
    <div className={s.wrap}>
      <Card className={s.card} size="large">
        <Text className={s.center}>Can’t reach the chores server, and this iPad hasn’t saved a list yet. Check the Wi-Fi.</Text>
        <Button size="large" appearance="primary" onClick={refresh}>Try again</Button>
      </Card>
    </div>
  );
}
