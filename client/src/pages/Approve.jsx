import { useMemo } from 'react';
import { Button, Caption1, Card, CardFooter, CardHeader, Spinner, Text, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowUndo24Regular, Checkmark24Regular, Gift24Regular } from '@fluentui/react-icons';
import { DECLINE_REASONS, SEND_BACK_REASONS } from '@shared/rules.js';
import { useApp } from '../data/AppData.jsx';
import { Empty, Page, Section } from '../components/Page.jsx';
import { ReasonDialog } from '../components/ReasonDialog.jsx';
import { dayLabel, joinNames, pts, whenLabel } from '../lib/util.js';
import { useDialog } from '../lib/useDialog.js';
import { PointsBadge } from '../components/Bits.jsx';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL },
  body: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS },
  footer: { justifyContent: 'flex-end', gap: tokens.spacingHorizontalM, flexWrap: 'wrap' },
  sending: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, color: tokens.colorNeutralForeground3 },
});

function Sending({ what }) {
  const s = useStyles();
  return (
    <span className={s.sending}>
      <Spinner size="tiny" /> {what === 'completion.sendBack' || what === 'redemption.decline' ? 'Sent back' : 'Approved'} · waiting to send
    </span>
  );
}

function CompletionCard({ c, names, today, endorse, onApprove, onSendBack }) {
  const s = useStyles();
  const each = c.contributorIds.length > 1 ? ' each' : '';
  const approvedBy = joinNames(c.approvals.map((a) => names.get(a.userId) ?? '?'));
  return (
    <Card className={s.card}>
      <CardHeader
        header={<Text size={400} weight="semibold">{c.taskName}</Text>}
        description={
          <Caption1>
            {joinNames(c.contributorNames)} · {whenLabel(c.submittedAt)}
            {c.periodStart !== today && ` · for ${dayLabel(c.periodStart).toLowerCase()}`}
          </Caption1>
        }
        action={<PointsBadge>{pts(c.share)}{each}</PointsBadge>}
      />
      <div className={s.body}>
        <Text><Text weight="semibold">What counts as done: </Text>{c.criterion || '—'}</Text>
        {endorse && <Caption1>Already approved by {approvedBy}. You can add your tick too.</Caption1>}
      </div>
      <CardFooter className={s.footer}>
        {c.queued ? (
          <Sending what={c.queued} />
        ) : (
          <>
            {!endorse && (
              <Button size="large" icon={<ArrowUndo24Regular />} onClick={() => onSendBack(c)}>Send back</Button>
            )}
            <Button size="large" appearance="primary" icon={<Checkmark24Regular />} onClick={() => onApprove(c)}>
              {endorse ? 'Approve too' : 'Approve'}
            </Button>
          </>
        )}
      </CardFooter>
    </Card>
  );
}

export function Approve() {
  const s = useStyles();
  const { view, enqueue } = useApp();
  const sendBack = useDialog();
  const decline = useDialog();
  const names = useMemo(() => new Map(view.users.map((u) => [u.id, u.nickname])), [view.users]);
  const { waiting, endorse, rewardRequests } = view.approve;

  const approve = (c) => enqueue('completion.approve', { completionId: c.id }, { label: c.taskName });
  const nothing = waiting.length === 0 && endorse.length === 0 && rewardRequests.length === 0;

  return (
    <Page title="Approve">
      {nothing && <Empty>Nothing is waiting for a tick right now.</Empty>}

      {waiting.length > 0 && (
        <Section title="Waiting for a tick">
          {waiting.map((c) => (
            <CompletionCard key={c.id} c={c} names={names} today={view.today} onApprove={approve} onSendBack={sendBack.show} />
          ))}
        </Section>
      )}

      {rewardRequests.length > 0 && (
        <Section title="Reward requests">
          {rewardRequests.map((r) => (
            <Card key={r.id} className={s.card}>
              <CardHeader
                image={<Gift24Regular />}
                header={<Text size={400} weight="semibold">{r.requesterName} would like: {r.rewardName}</Text>}
                description={<Caption1>{whenLabel(r.requestedAt)}</Caption1>}
                action={<PointsBadge>{pts(r.cost)}</PointsBadge>}
              />
              <CardFooter className={s.footer}>
                {r.queued ? (
                  <Sending what={r.queued} />
                ) : (
                  <>
                    <Button size="large" onClick={() => decline.show(r)}>Not now</Button>
                    <Button
                      size="large"
                      appearance="primary"
                      icon={<Checkmark24Regular />}
                      onClick={() => enqueue('redemption.approve', { redemptionId: r.id }, { label: r.rewardName })}
                    >
                      Approve
                    </Button>
                  </>
                )}
              </CardFooter>
            </Card>
          ))}
        </Section>
      )}

      {endorse.length > 0 && (
        <Section title="Add your tick too">
          {endorse.map((c) => (
            <CompletionCard key={c.id} c={c} names={names} today={view.today} endorse onApprove={approve} />
          ))}
        </Section>
      )}

      <ReasonDialog
        open={sendBack.open}
        title={`Send back ${sendBack.data?.taskName ?? ''}`}
        intro={sendBack.data ? `It goes back to ${joinNames(sendBack.data.contributorNames)} with your reason.` : ''}
        reasons={SEND_BACK_REASONS}
        noteLabel="What still needs doing?"
        confirmLabel="Send back"
        onCancel={sendBack.hide}
        onConfirm={({ reasons, note }) => {
          enqueue('completion.sendBack', { completionId: sendBack.data.id, reasons, note }, { label: sendBack.data.taskName });
          sendBack.hide();
        }}
      />
      <ReasonDialog
        open={decline.open}
        title={`Not now: ${decline.data?.rewardName ?? ''}`}
        reasons={DECLINE_REASONS}
        noteLabel="Anything to add?"
        confirmLabel="Send"
        onCancel={decline.hide}
        onConfirm={({ reasons, note }) => {
          enqueue('redemption.decline', { redemptionId: decline.data.id, reasons, note }, { label: decline.data.rewardName });
          decline.hide();
        }}
      />
    </Page>
  );
}
