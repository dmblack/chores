import { useCallback, useEffect, useState } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Caption1,
  Card,
  CardHeader,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Spinner,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add24Regular, Edit24Regular } from '../icons.js';
import { useApp } from '../data/AppData.jsx';
import { Page, Section } from '../components/Page.jsx';
import { api } from '../lib/api.js';
import { pts } from '../lib/util.js';
import { useDialog } from '../lib/useDialog.js';
import { KeptDialog } from '../components/KeptDialog.jsx';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
  inactive: { opacity: 0.6 },
});

function PersonForm({ person, onClose, onSaved }) {
  const s = useStyles();
  const isNew = !person.id;
  const [f, setF] = useState({
    nickname: person.nickname ?? '',
    username: person.username ?? '',
    role: person.role ?? 'kid',
    birthDate: person.birthDate ?? '',
    active: person.active ?? true,
    password: '',
  });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (_, d) => setF({ ...f, [k]: d.value });

  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (isNew) {
        await api.post('/api/users', { ...f, username: f.username.trim() });
      } else {
        const changes = { nickname: f.nickname, username: f.username.trim(), role: f.role, birthDate: f.birthDate, active: f.active };
        if (f.password) changes.password = f.password;
        await api.patch(`/api/users/${person.id}`, changes);
      }
      await onSaved();
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
        <DialogBody>
          <DialogTitle>{isNew ? 'Add a person' : `Edit ${person.nickname}`}</DialogTitle>
          <DialogContent className={s.form}>
            <Field label="Name shown in the app" required><Input size="large" value={f.nickname} onChange={set('nickname')} maxLength={30} /></Field>
            <Field label="Username" required hint="For signing in with a password">
              <Input size="large" value={f.username} onChange={set('username')} autoCapitalize="none" autoCorrect="off" maxLength={32} />
            </Field>
            <Field label="Birth date" required hint="Age is worked out from this, for tasks with a minimum age">
              <Input size="large" type="date" value={f.birthDate} onChange={set('birthDate')} />
            </Field>
            <Field label="Role">
              <RadioGroup value={f.role} onChange={(_, d) => setF({ ...f, role: d.value })} layout="horizontal">
                <Radio value="kid" label="Kid" />
                <Radio value="grownup" label="Grown-up (manages tasks and rewards)" />
              </RadioGroup>
            </Field>
            <Field label={isNew ? 'Password' : 'New password'} required={isNew} hint={isNew ? 'At least 6 characters. They can set their own PIN after signing in.' : 'Leave blank to keep the current one'}>
              <Input size="large" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" />
            </Field>
            {!isNew && (
              <Switch checked={f.active} onChange={(_, d) => setF({ ...f, active: d.checked })} label={f.active ? 'Account switched on' : 'Account switched off (history is kept)'} />
            )}
            {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button size="large" onClick={onClose}>Cancel</Button>
            <Button size="large" appearance="primary" disabled={busy} onClick={save}>{isNew ? 'Add' : 'Save'}</Button>
          </DialogActions>
        </DialogBody>
  );
}

export function People() {
  const s = useStyles();
  const { online, refresh } = useApp();
  const [people, setPeople] = useState(null);
  const [error, setError] = useState(null);
  const editing = useDialog();

  const loadPeople = useCallback(async () => {
    try {
      setPeople(await api.get('/api/users'));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }, []);
  useEffect(() => {
    loadPeople();
  }, [loadPeople]);

  return (
    <Page title="People" actions={<Button size="large" appearance="primary" icon={<Add24Regular />} disabled={!online} onClick={() => editing.show({})}>Add person</Button>}>
      {error && <MessageBar intent="warning"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
      {!people && !error && <Spinner />}
      {people && (
        <Section>
          {people.map((p) => (
            <Card key={p.id} className={`${s.card} ${p.active ? '' : s.inactive}`}>
              <CardHeader
                image={<Avatar name={p.nickname} size={40} color="colorful" />}
                header={<Text size={400} weight="semibold">{p.nickname}</Text>}
                description={
                  <Caption1>
                    @{p.username} · {p.role === 'grownup' ? 'Grown-up' : 'Kid'} · age {p.age} · {pts(p.balance)}
                    {p.hasPin ? ' · PIN set' : ' · no PIN yet'}
                  </Caption1>
                }
                action={
                  <>
                    {!p.active && <Badge color="subtle">Switched off</Badge>}
                    <Button icon={<Edit24Regular />} aria-label={`Edit ${p.nickname}`} disabled={!online} onClick={() => editing.show(p)} />
                  </>
                }
              />
            </Card>
          ))}
        </Section>
      )}
      <KeptDialog dialog={editing}>
        {(person) => (
          <PersonForm
            person={person}
            onClose={editing.hide}
            onSaved={async () => {
              await loadPeople();
              await refresh();
            }}
          />
        )}
      </KeptDialog>
    </Page>
  );
}
