import { useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Card,
  CardFooter,
  CardHeader,
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
  SpinButton,
  Text,
  Title1,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Add24Regular, Delete24Regular, Edit24Regular, Gift24Regular, Star24Filled } from '@fluentui/react-icons';
import { DECLINE_REASONS } from '@shared/rules.js';
import { useApp } from '../data/AppData.jsx';
import { Empty, Page, Section } from '../components/Page.jsx';
import { reasonText } from '../components/ReasonDialog.jsx';
import { pts, uuid, whenLabel } from '../lib/util.js';
import { useDialog } from '../lib/useDialog.js';
import { KeptDialog } from '../components/KeptDialog.jsx';
import { PointsBadge } from '../components/Bits.jsx';

const useStyles = makeStyles({
  balance: { padding: tokens.spacingHorizontalXL, marginBottom: tokens.spacingVerticalXL, alignItems: 'center', textAlign: 'center' },
  star: { color: tokens.colorPaletteMarigoldForeground1, display: 'inline-flex', alignItems: 'center', gap: tokens.spacingHorizontalS },
  card: { padding: tokens.spacingHorizontalL },
  footer: { justifyContent: 'flex-end', gap: tokens.spacingHorizontalS, flexWrap: 'wrap' },
  row: { display: 'flex', justifyContent: 'space-between', gap: tokens.spacingHorizontalM, paddingBlock: tokens.spacingVerticalS, borderBottom: `1px solid ${tokens.colorNeutralStroke2}` },
  plus: { color: tokens.colorPaletteGreenForeground1, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  minus: { color: tokens.colorPaletteRedForeground1, fontWeight: tokens.fontWeightSemibold, whiteSpace: 'nowrap' },
  form: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

const STATUS = {
  pending: { label: 'Waiting', color: 'warning' },
  approved: { label: 'Approved', color: 'success' },
  declined: { label: 'Not now', color: 'danger' },
  cancelled: { label: 'Cancelled', color: 'subtle' },
};

function RewardForm({ reward, onClose }) {
  const s = useStyles();
  const { sendNow } = useApp();
  const [f, setF] = useState({ name: reward?.name ?? '', description: reward?.description ?? '', cost: reward?.cost ?? 20 });
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try {
      if (reward?.id) await sendNow('reward.update', { rewardId: reward.id, def: f });
      else await sendNow('reward.create', { rewardId: uuid(), def: f });
      onClose();
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }
  return (
        <DialogBody>
          <DialogTitle>{reward?.id ? 'Edit reward' : 'New reward'}</DialogTitle>
          <DialogContent className={s.form}>
            <Field label="Reward" required><Input size="large" value={f.name} maxLength={60} onChange={(_, d) => setF({ ...f, name: d.value })} placeholder="Extra game time" /></Field>
            <Field label="Details"><Input size="large" value={f.description} maxLength={200} onChange={(_, d) => setF({ ...f, description: d.value })} placeholder="30 minutes" /></Field>
            <Field label="Cost in points" required>
              <SpinButton size="large" min={1} max={100000} value={f.cost} onChange={(_, d) => setF({ ...f, cost: d.value ?? (parseInt(d.displayValue, 10) || f.cost) })} />
            </Field>
            {error && <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar>}
          </DialogContent>
          <DialogActions>
            <Button size="large" onClick={onClose}>Cancel</Button>
            <Button size="large" appearance="primary" disabled={busy} onClick={save}>Save</Button>
          </DialogActions>
        </DialogBody>
  );
}

export function Rewards() {
  const s = useStyles();
  const { view, enqueue, sendNow, online } = useApp();
  const asking = useDialog();
  const editing = useDialog();
  const grownup = view.me.role === 'grownup';
  const { balance, available, history } = view.points;

  return (
    <Page title="Rewards">
      <Card className={s.balance}>
        <Title1 className={s.star}><Star24Filled /> {balance}</Title1>
        <Text>points{available !== balance ? ` · ${pts(balance - available)} held for requests` : ''}</Text>
      </Card>

      <Section
        title="Rewards to choose from"
        action={grownup && <Button appearance="subtle" icon={<Add24Regular />} disabled={!online} onClick={() => editing.show({})}>Add</Button>}
      >
        {view.rewards.length === 0 && <Empty>{grownup ? 'Add rewards everyone can spend points on.' : 'No rewards yet. Ask a grown-up to add some.'}</Empty>}
        {view.rewards.map((r) => (
          <Card key={r.id} className={s.card}>
            <CardHeader
              image={<Gift24Regular />}
              header={<Text size={400} weight="semibold">{r.name}</Text>}
              description={r.description && <Caption1>{r.description}</Caption1>}
              action={<PointsBadge>{pts(r.cost)}</PointsBadge>}
            />
            <CardFooter className={s.footer}>
              {grownup && (
                <>
                  <Button icon={<Edit24Regular />} aria-label={`Edit ${r.name}`} disabled={!online} onClick={() => editing.show(r)} />
                  <Button icon={<Delete24Regular />} aria-label={`Remove ${r.name}`} disabled={!online} onClick={() => sendNow('reward.remove', { rewardId: r.id }).catch(() => {})} />
                </>
              )}
              <Button size="large" appearance="primary" disabled={available < r.cost} onClick={() => asking.show(r)}>
                {available < r.cost ? `Need ${pts(r.cost - available)} more` : 'Ask for this'}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </Section>

      {view.myRedemptions.length > 0 && (
        <Section title="My requests">
          {view.myRedemptions.map((r) => (
            <Card key={r.id} className={s.card}>
              <CardHeader
                header={<Text weight="semibold">{r.rewardName}</Text>}
                description={
                  <Caption1>
                    {pts(r.cost)} · {whenLabel(r.requestedAt)}
                    {r.queued === true && ' · waiting to send'}
                    {r.status === 'declined' && ` · ${reasonText(r.reasons, r.note, DECLINE_REASONS)}`}
                  </Caption1>
                }
                action={<Badge color={STATUS[r.status].color}>{STATUS[r.status].label}</Badge>}
              />
              {r.status === 'pending' && !r.queued && (
                <CardFooter className={s.footer}>
                  <Button onClick={() => enqueue('redemption.cancel', { redemptionId: r.id }, { label: r.rewardName })}>Cancel request</Button>
                </CardFooter>
              )}
            </Card>
          ))}
        </Section>
      )}

      <Section title="Points history">
        {history.length === 0 && <Caption1>No points yet. Get a task approved to earn some.</Caption1>}
        {history.map((h) => (
          <div key={`${h.seq}`} className={s.row}>
            <div>
              <Text block>{h.reason === 'approval' ? h.label : h.reason === 'reward' ? `Spent on ${h.label}` : h.label}</Text>
              <Caption1>{whenLabel(h.at)}</Caption1>
            </div>
            <span className={h.amount >= 0 ? s.plus : s.minus}>{h.amount >= 0 ? '+' : '−'}{Math.abs(h.amount)}</span>
          </div>
        ))}
      </Section>

      <Dialog open={asking.open} onOpenChange={(_, d) => !d.open && asking.hide()}>
        <DialogSurface>
          <DialogBody>
            <DialogTitle>Ask for {asking.data?.name}?</DialogTitle>
            <DialogContent>A grown-up will approve it, then {pts(asking.data?.cost ?? 0)} come off your balance.</DialogContent>
            <DialogActions>
              <Button size="large" onClick={asking.hide}>Not yet</Button>
              <Button
                size="large"
                appearance="primary"
                onClick={() => {
                  const r = asking.data;
                  enqueue('redemption.request', { redemptionId: uuid(), rewardId: r.id }, { label: r.name, cost: r.cost });
                  asking.hide();
                }}
              >
                Ask
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
      <KeptDialog dialog={editing}>{(reward) => <RewardForm reward={reward} onClose={editing.hide} />}</KeptDialog>
    </Page>
  );
}
