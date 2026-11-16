import { useState } from 'react';
import { Button, Caption1, Card, Field, Input, MessageBar, MessageBarBody, SpinButton, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add24Regular, Delete24Regular } from '../icons.js';
import { useApp } from '../data/AppData.jsx';
import { Page, Section } from '../components/Page.jsx';
import { dayLabel } from '../lib/util.js';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL, gap: tokens.spacingVerticalM },
  row: { display: 'flex', gap: tokens.spacingHorizontalM, flexWrap: 'wrap', alignItems: 'flex-end' },
  holiday: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
});

export function Settings() {
  const s = useStyles();
  const { view, sendNow, online } = useApp();
  const [approvalPoints, setApprovalPoints] = useState(view.settings.approvalPoints);
  const [holiday, setHoliday] = useState({ from: '', to: '', label: '' });
  const [msg, setMsg] = useState(null);

  const save = async (settings, ok) => {
    setMsg(null);
    try {
      await sendNow('settings.update', { settings });
      setMsg({ tone: 'success', text: ok });
      return true;
    } catch (e) {
      setMsg({ tone: 'error', text: e.message });
      return false;
    }
  };
  const holidays = [...view.settings.holidays].sort((a, b) => a.from.localeCompare(b.from));

  return (
    <Page title="Settings">
      {msg && <MessageBar intent={msg.tone} style={{ marginBottom: tokens.spacingVerticalL }}><MessageBarBody>{msg.text}</MessageBarBody></MessageBar>}
      <Section title="Points for checking">
        <Card className={s.card}>
          <Text>Points someone earns each time they approve another person’s task (including extra ticks when a task allows multiple approvals).</Text>
          <div className={s.row}>
            <Field label="Approval points">
              <SpinButton size="large" min={0} max={100} value={approvalPoints} onChange={(_, d) => setApprovalPoints(d.value ?? (parseInt(d.displayValue, 10) || 0))} />
            </Field>
            <Button size="large" appearance="primary" disabled={!online || approvalPoints === view.settings.approvalPoints} onClick={() => save({ approvalPoints }, 'Saved')}>
              Save
            </Button>
          </div>
        </Card>
      </Section>

      <Section title="Holidays">
        <Card className={s.card}>
          <Text>On holidays, “school days” tasks are off the list and “weekends and holidays” tasks are on it.</Text>
          {holidays.length === 0 && <Caption1>No holidays added.</Caption1>}
          {holidays.map((h, i) => (
            <div key={`${h.from}-${h.to}-${i}`} className={s.holiday}>
              <div>
                <Text block weight="semibold">{h.label || 'Holiday'}</Text>
                <Caption1>{dayLabel(h.from)}{h.to !== h.from ? ` – ${dayLabel(h.to)}` : ''}</Caption1>
              </div>
              <Button
                icon={<Delete24Regular />}
                aria-label="Remove holiday"
                disabled={!online}
                onClick={() => save({ holidays: holidays.filter((x) => x !== h) }, 'Holiday removed')}
              />
            </div>
          ))}
          <div className={s.row}>
            <Field label="Name"><Input size="large" value={holiday.label} maxLength={60} placeholder="School holidays" onChange={(_, d) => setHoliday({ ...holiday, label: d.value })} /></Field>
            <Field label="From"><Input size="large" type="date" value={holiday.from} onChange={(_, d) => setHoliday({ ...holiday, from: d.value, to: holiday.to || d.value })} /></Field>
            <Field label="To"><Input size="large" type="date" value={holiday.to} onChange={(_, d) => setHoliday({ ...holiday, to: d.value })} /></Field>
            <Button
              size="large"
              icon={<Add24Regular />}
              disabled={!online || !holiday.from || !holiday.to}
              onClick={async () => {
                if (await save({ holidays: [...holidays, holiday] }, 'Holiday added')) setHoliday({ from: '', to: '', label: '' });
              }}
            >
              Add
            </Button>
          </div>
        </Card>
      </Section>
    </Page>
  );
}
