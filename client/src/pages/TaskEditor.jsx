import { useState } from 'react';
import {
  Accordion,
  AccordionHeader,
  AccordionItem,
  AccordionPanel,
  Button,
  Caption1,
  Card,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Input,
  MessageBar,
  MessageBarBody,
  Radio,
  RadioGroup,
  Select,
  SpinButton,
  Switch,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Delete24Regular } from '../icons.js';
import { ALLOCATIONS, LISTS, TASK_DEFAULTS, TASK_KINDS, advancedSummary, normaliseTaskDef } from '@shared/rules.js';
import { REPEAT_OPTIONS } from '@shared/schedule.js';
import { WEEKDAY_SHORT, localDate } from '@shared/dates.js';
import { useApp } from '../data/AppData.jsx';
import { Page } from '../components/Page.jsx';
import { go } from '../lib/router.js';
import { uuid } from '../lib/util.js';
import { Chip } from '../components/Bits.jsx';

const useStyles = makeStyles({
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL },
  card: { padding: tokens.spacingHorizontalL, gap: tokens.spacingVerticalL },
  row: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, alignItems: 'flex-end' },
  days: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalXS },
  advHeader: { display: 'flex', flexDirection: 'column', alignItems: 'flex-start' },
  advPanel: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalL, paddingBlock: tokens.spacingVerticalM },
  actions: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalM, justifyContent: 'space-between' },
  right: { display: 'flex', gap: tokens.spacingHorizontalM, marginLeft: 'auto' },
});

function repeatFor(type, prev) {
  if (type === 'weekdays') return { type, days: prev?.days ?? [1, 2, 3, 4, 5] };
  if (type === 'interval') return { type, every: prev?.every ?? 1, unit: prev?.unit ?? 'weeks', start: prev?.start ?? localDate() };
  return { type };
}

function spinValue(data, fallback) {
  if (data.value != null) return data.value;
  const n = parseInt(data.displayValue ?? '', 10);
  return Number.isNaN(n) ? fallback : n;
}

export function TaskEditor({ taskId, list }) {
  const s = useStyles();
  const { view, sendNow, online } = useApp();
  const existing = taskId ? view.tasks?.find((t) => t.id === taskId) : null;
  const [def, setDef] = useState(() =>
    existing
      ? { ...existing }
      : { name: '', criterion: '', points: 5, list: LISTS.some((l) => l.id === list) ? list : 'morning', repeat: { type: 'daily' }, ...TASK_DEFAULTS },
  );
  const [minAgeText, setMinAgeText] = useState(def.minAge == null ? '' : String(def.minAge));
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const set = (patch) => setDef((d) => ({ ...d, ...patch }));

  if (taskId && !existing) {
    return <Page title="Task" back="/manage"><Text>That task no longer exists.</Text></Page>;
  }

  const summary = advancedSummary(def);

  async function save(e) {
    e.preventDefault();
    const minAge = minAgeText.trim() === '' ? null : Number(minAgeText);
    const { def: clean, error: err } = normaliseTaskDef({ ...def, minAge: Number.isInteger(minAge) ? minAge : minAge === null ? null : -1 });
    if (err) return setError(err);
    setBusy(true);
    setError(null);
    try {
      if (existing) await sendNow('task.update', { taskId: existing.id, def: clean });
      else await sendNow('task.create', { taskId: uuid(), def: clean });
      go('/manage');
    } catch (err2) {
      setError(err2.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeTask() {
    setBusy(true);
    try {
      await sendNow('task.remove', { taskId: existing.id });
      go('/manage');
    } catch (err) {
      setError(err.message);
      setBusy(false);
      setConfirmRemove(false);
    }
  }

  const r = def.repeat;
  return (
    <Page title={existing ? 'Edit task' : 'New task'} back="/manage">
      <form className={s.form} onSubmit={save}>
        <Card className={s.card}>
          <Field label="Task name" required>
            <Input size="large" value={def.name} onChange={(_, d) => set({ name: d.value })} maxLength={80} placeholder="Unload the dishwasher" />
          </Field>
          <Field label="What counts as done?" required hint="One line, so everyone agrees when it’s finished">
            <Input
              size="large"
              value={def.criterion}
              onChange={(_, d) => set({ criterion: d.value })}
              maxLength={200}
              placeholder="Dishes put away in cupboards and drawers, not left on the bench"
            />
          </Field>
          <div className={s.row}>
            <Field label="Points" required>
              <SpinButton size="large" value={def.points} min={0} max={1000} onChange={(_, d) => set({ points: spinValue(d, def.points) })} />
            </Field>
            <Field label="List">
              <Select size="large" value={def.list} onChange={(_, d) => set({ list: d.value })}>
                {LISTS.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
              </Select>
            </Field>
          </div>
          <Field label="When it repeats" required>
            <Select size="large" value={r.type} onChange={(_, d) => set({ repeat: repeatFor(d.value, r) })}>
              {REPEAT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </Select>
          </Field>
          {r.type === 'weekdays' && (
            <div className={s.days} role="group" aria-label="Days">
              {[1, 2, 3, 4, 5, 6, 0].map((d) => (
                <Chip
                  key={d}
                  checked={r.days.includes(d)}
                  onClick={() => set({ repeat: { ...r, days: r.days.includes(d) ? r.days.filter((x) => x !== d) : [...r.days, d] } })}
                >
                  {WEEKDAY_SHORT[d]}
                </Chip>
              ))}
            </div>
          )}
          {r.type === 'interval' && (
            <div className={s.row}>
              <Field label="Every">
                <SpinButton size="large" value={r.every} min={1} max={365} onChange={(_, d) => set({ repeat: { ...r, every: spinValue(d, r.every) } })} />
              </Field>
              <Field label="Unit">
                <Select size="large" value={r.unit} onChange={(_, d) => set({ repeat: { ...r, unit: d.value } })}>
                  <option value="days">days</option>
                  <option value="weeks">weeks</option>
                </Select>
              </Field>
              <Field label="Starting">
                <Input size="large" type="date" value={r.start} onChange={(_, d) => set({ repeat: { ...r, start: d.value } })} />
              </Field>
            </div>
          )}
          {r.type === 'interval' && <Caption1>It stays on the list until it’s done, then comes back when the next period starts.</Caption1>}
          <Field label="Who does it?">
            <RadioGroup value={def.kind} onChange={(_, d) => set({ kind: d.value })} layout="horizontal">
              {TASK_KINDS.map((k) => <Radio key={k.id} value={k.id} label={k.label} />)}
            </RadioGroup>
          </Field>
        </Card>

        <Accordion collapsible>
          <AccordionItem value="advanced">
            <AccordionHeader size="large">
              <span className={s.advHeader}>
                <Text weight="semibold">Advanced settings</Text>
                {summary && <Caption1>{summary}</Caption1>}
              </span>
            </AccordionHeader>
            <AccordionPanel className={s.advPanel}>
              <Switch
                label="Allow collaboration: several people can do it together"
                checked={def.allowCollaboration}
                onChange={(_, d) => set({ allowCollaboration: d.checked })}
              />
              <Field label="How points are awarded" hint={def.allowCollaboration ? undefined : 'Only matters when collaboration is allowed. One person always gets the full points.'}>
                <RadioGroup value={def.allocation} disabled={!def.allowCollaboration} onChange={(_, d) => set({ allocation: d.value })}>
                  {ALLOCATIONS.map((a) => <Radio key={a.id} value={a.id} label={a.label} />)}
                </RadioGroup>
              </Field>
              {def.allowCollaboration && def.allocation === 'split' && (
                <Caption1>Shares round up: {def.points} points between 3 people is {Math.ceil(def.points / 3)} each.</Caption1>
              )}
              <Switch
                label="Allow multiple approvals: other people can add their tick after the first"
                checked={def.allowMultipleApprovals}
                onChange={(_, d) => set({ allowMultipleApprovals: d.checked })}
              />
              <Field label="Minimum age" hint="Leave blank for anyone. Younger people won’t see this task.">
                <Input
                  size="large"
                  type="number"
                  inputMode="numeric"
                  min={1}
                  max={99}
                  value={minAgeText}
                  onChange={(_, d) => setMinAgeText(d.value)}
                  style={{ maxWidth: '140px' }}
                />
              </Field>
            </AccordionPanel>
          </AccordionItem>
        </Accordion>

        {error && (
          <MessageBar intent="error">
            <MessageBarBody>{error}</MessageBarBody>
          </MessageBar>
        )}
        {!online && (
          <MessageBar intent="warning">
            <MessageBarBody>Editing tasks needs a connection to the chores server.</MessageBarBody>
          </MessageBar>
        )}

        <div className={s.actions}>
          {existing && (
            <Button size="large" icon={<Delete24Regular />} onClick={() => setConfirmRemove(true)} disabled={busy || !online}>Remove task</Button>
          )}
          <div className={s.right}>
            <Button size="large" onClick={() => go('/manage')}>Cancel</Button>
            <Button size="large" appearance="primary" type="submit" disabled={busy || !online}>{existing ? 'Save' : 'Create task'}</Button>
          </div>
        </div>
      </form>

      <Dialog open={confirmRemove} onOpenChange={(_, d) => setConfirmRemove(d.open)}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Remove {existing?.name}?</DialogTitle>
            <DialogContent>It comes off everyone’s lists from now on. Its history and points already earned stay.</DialogContent>
            <DialogActions>
              <Button size="large" onClick={() => setConfirmRemove(false)}>Keep it</Button>
              <Button size="large" appearance="primary" onClick={removeTask} disabled={busy}>Remove</Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </Page>
  );
}
