import { useState } from 'react';
import { Button, Card, Field, Input, MessageBar, MessageBarBody, Text, makeStyles, tokens } from '@fluentui/react-components';
import { SignOut24Regular } from '../icons.js';
import { useApp } from '../data/AppData.jsx';
import { Page, Section } from '../components/Page.jsx';
import { api } from '../lib/api.js';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL, gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  stack: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM, maxWidth: '420px' },
});

function useForm(initial) {
  const [f, setF] = useState(initial);
  const [msg, setMsg] = useState(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn, ok) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: 'success', text: ok });
      setF(initial);
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const bind = (k) => ({ value: f[k], onChange: (_, d) => setF((x) => ({ ...x, [k]: d.value })) });
  return { f, bind, msg, busy, run };
}

const Msg = ({ msg }) => msg && <MessageBar intent={msg.tone}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>;

export function Profile() {
  const s = useStyles();
  const { view, online, queue, signOut, refresh } = useApp();
  const unsent = queue.filter((a) => a.userId === view.me.id).length;
  const name = useForm({ nickname: view.me.nickname });
  const pin = useForm({ pin: '', currentPassword: '' });
  const pw = useForm({ currentPassword: '', newPassword: '', confirm: '' });

  return (
    <Page title="Profile">
      <Section title="Name">
        <Card className={s.card}>
          <div className={s.row}>
            <Field label="Name shown in the app" style={{ flexGrow: 1 }}><Input size="large" maxLength={30} {...name.bind('nickname')} /></Field>
            <Button
              size="large"
              disabled={name.busy || !online}
              onClick={() => name.run(async () => { await api.patch('/api/me', { nickname: name.f.nickname }); await refresh(); }, 'Saved')}
            >
              Save
            </Button>
          </div>
          <Msg msg={name.msg} />
        </Card>
      </Section>

      <Section title="PIN">
        <Card className={s.card}>
          <Text>Sign in with just a 6-digit PIN. Each person’s PIN must be different.</Text>
          <div className={s.row}>
            <Field label="New PIN">
              <Input size="large" type="password" inputMode="numeric" pattern="[0-9]*" maxLength={6} autoComplete="off" {...pin.bind('pin')} />
            </Field>
            <Field label="Your password">
              <Input size="large" type="password" autoComplete="current-password" {...pin.bind('currentPassword')} />
            </Field>
            <Button
              size="large"
              appearance="primary"
              disabled={pin.busy || !online || !/^\d{6}$/.test(pin.f.pin) || !pin.f.currentPassword}
              onClick={() => pin.run(() => api.post('/api/me/pin', pin.f), 'PIN saved')}
            >
              Set PIN
            </Button>
          </div>
          <Msg msg={pin.msg} />
        </Card>
      </Section>

      <Section title="Password">
        <Card className={s.card}>
          <div className={s.stack}>
            <Field label="Current password"><Input size="large" type="password" autoComplete="current-password" {...pw.bind('currentPassword')} /></Field>
            <Field label="New password" hint="At least 6 characters"><Input size="large" type="password" autoComplete="new-password" {...pw.bind('newPassword')} /></Field>
            <Field label="New password again"><Input size="large" type="password" autoComplete="new-password" {...pw.bind('confirm')} /></Field>
          </div>
          <Button
            size="large"
            disabled={pw.busy || !online || !pw.f.newPassword || pw.f.newPassword !== pw.f.confirm}
            onClick={() => pw.run(() => api.post('/api/me/password', { currentPassword: pw.f.currentPassword, newPassword: pw.f.newPassword }), 'Password changed')}
          >
            Change password
          </Button>
          <Msg msg={pw.msg} />
        </Card>
      </Section>

      <Section title="This iPad">
        {unsent > 0 && (
          <MessageBar intent="warning">
            <MessageBarBody>{unsent} change(s) haven’t reached the server yet. Connect to the home Wi-Fi before switching person.</MessageBarBody>
          </MessageBar>
        )}
        {!online && <Text>Switching person needs a connection to the chores server.</Text>}
        <Button size="large" icon={<SignOut24Regular />} disabled={!online || unsent > 0} onClick={() => signOut().catch(() => {})}>
          Switch person (sign out)
        </Button>
      </Section>
    </Page>
  );
}
