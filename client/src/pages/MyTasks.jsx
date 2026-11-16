import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  Caption1,
  Card,
  CardHeader,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  MessageBarTitle,
  Text,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import {
  ArrowUndo24Regular,
  CheckmarkCircle24Filled,
  Circle24Regular,
  Clock24Regular,
  CloudArrowUp24Regular,
} from '@fluentui/react-icons';
import { ALLOCATIONS, LISTS, SEND_BACK_REASONS, shareFor } from '@shared/rules.js';
import { useApp } from '../data/AppData.jsx';
import { Empty, Page, Section } from '../components/Page.jsx';
import { reasonText } from '../components/ReasonDialog.jsx';
import { dayLabel, joinNames, pts, uuid } from '../lib/util.js';
import { useDialog } from '../lib/useDialog.js';
import { KeptDialog } from '../components/KeptDialog.jsx';
import { Chip, PointsBadge } from '../components/Bits.jsx';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL },
  done: { opacity: 0.75 },
  todoIcon: { color: tokens.colorNeutralForeground3 },
  approvedIcon: { color: tokens.colorPaletteGreenForeground1 },
  pendingIcon: { color: tokens.colorPaletteMarigoldForeground1 },
  backIcon: { color: tokens.colorPaletteRedForeground1 },
  meta: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: tokens.spacingHorizontalS, marginTop: tokens.spacingVerticalXS },
  helpers: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginBlock: tokens.spacingVerticalS },
  dialogText: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalM },
});

function pointsLabel(t) {
  if (!t.allowCollaboration) return pts(t.points);
  return t.allocation === 'split' ? `${pts(t.points)} · split if shared` : `${pts(t.points)} each`;
}

function StatusIcon({ status, queued }) {
  const s = useStyles();
  if (queued) return <CloudArrowUp24Regular className={s.pendingIcon} />;
  if (status === 'approved') return <CheckmarkCircle24Filled className={s.approvedIcon} />;
  if (status === 'pending') return <Clock24Regular className={s.pendingIcon} />;
  if (status === 'sentBack') return <ArrowUndo24Regular className={s.backIcon} />;
  return <Circle24Regular className={s.todoIcon} />;
}

function statusLine(t, names) {
  const c = t.completion;
  if (t.queued) return 'Marked done · waiting to send';
  if (t.status === 'pending') return `Waiting for a tick · done by ${joinNames(c.contributorNames)}`;
  if (t.status === 'approved') {
    const by = joinNames(c.approvals.map((a) => names.get(a.userId) ?? '?'));
    return `Approved by ${by} · ${pts(c.share)}${c.contributorIds.length > 1 ? ' each' : ''}`;
  }
  if (t.status === 'sentBack') return `Sent back by ${names.get(c.sentBack.by) ?? '?'}: ${reasonText(c.sentBack.reasons, c.sentBack.note, SEND_BACK_REASONS)}`;
  return null;
}

function TaskCard({ task, names, meId, onOpen }) {
  const s = useStyles();
  const actionable = !task.queued && (task.status === 'todo' || task.status === 'sentBack');
  const line = statusLine(task, names);
  return (
    <Card
      className={`${s.card} ${actionable ? '' : s.done}`}
      onClick={actionable ? () => onOpen(task) : undefined}
      aria-label={actionable ? `Mark ${task.name} done` : undefined}
    >
      <CardHeader
        image={<StatusIcon status={task.status} queued={task.queued} />}
        header={<Text size={400} weight="semibold">{task.name}</Text>}
        description={<Caption1>{task.criterion}</Caption1>}
        action={<PointsBadge>{pointsLabel(task)}</PointsBadge>}
      />
      {(line || task.kind === 'personal') && (
        <div className={s.meta}>
          {task.kind === 'personal' && (
            <Badge appearance="outline" color="informative">{task.ownerId === meId ? 'Your own' : `${names.get(task.ownerId)}’s`}</Badge>
          )}
          {line && <Caption1>{line}</Caption1>}
        </div>
      )}
    </Card>
  );
}

function MarkDoneForm({ task, onClose }) {
  const s = useStyles();
  const { view, enqueue } = useApp();
  const names = new Map(view.users.map((u) => [u.id, u.nickname]));
  const me = view.me.id;
  const ownerId = task.ownerId;
  const locked = ownerId && ownerId !== me ? [ownerId] : []; // helping finish someone else's own task
  const previous = task.status === 'sentBack' ? task.completion.contributorIds.filter((id) => id !== me && task.helpers.includes(id)) : [];
  const [helpers, setHelpers] = useState(() => [...new Set([...locked, ...previous])]);
  const toggle = (id) => setHelpers((h) => (h.includes(id) ? h.filter((x) => x !== id) : [...h, id]));
  const contributors = [me, ...helpers];
  const share = shareFor(task.points, task.allocation, contributors.length);
  const allocation = ALLOCATIONS.find((a) => a.id === task.allocation);

  function confirm() {
    enqueue(
      'completion.submit',
      { completionId: uuid(), taskId: task.taskId, periodStart: task.periodStart, ownerId, contributorIds: contributors },
      { occurrenceId: task.occurrenceId, label: task.name },
    );
    onClose();
  }

  return (
        <DialogBody>
          <DialogTitle>{task.name}</DialogTitle>
          <DialogContent className={s.dialogText}>
            <Text><Text weight="semibold">What counts as done: </Text>{task.criterion}</Text>
            {task.status === 'sentBack' && (
              <MessageBar intent="warning">
                <MessageBarBody>
                  <MessageBarTitle>Sent back</MessageBarTitle>
                  {reasonText(task.completion.sentBack.reasons, task.completion.sentBack.note, SEND_BACK_REASONS)}
                </MessageBarBody>
              </MessageBar>
            )}
            {task.allowCollaboration && (task.helpers.length > 0 || locked.length > 0) && (
              <div>
                <Text weight="semibold">Did anyone help?</Text>
                <div className={s.helpers} role="group" aria-label="Helpers">
                  {[...new Set([...locked, ...task.helpers])].map((id) => (
                    <Chip
                      key={id}
                      checked={helpers.includes(id)}
                      disabled={locked.includes(id)}
                      onClick={() => toggle(id)}
                    >
                      {names.get(id)}
                    </Chip>
                  ))}
                </div>
                <Caption1>{allocation?.label}</Caption1>
              </div>
            )}
            <Text>
              {contributors.length === 1
                ? `You’ll get ${pts(share)} when someone else approves it.`
                : `${joinNames(['You', ...helpers.map((id) => names.get(id))])} will each get ${pts(share)} when someone who didn’t help approves it.`}
            </Text>
          </DialogContent>
          <DialogActions>
            <Button size="large" onClick={onClose}>Not yet</Button>
            <Button size="large" appearance="primary" onClick={confirm}>Mark done</Button>
          </DialogActions>
        </DialogBody>
  );
}

export function MyTasks() {
  const { view } = useApp();
  const markDone = useDialog();
  const names = useMemo(() => new Map(view.users.map((u) => [u.id, u.nickname])), [view.users]);
  const groups = LISTS.map((l) => ({ ...l, tasks: view.myTasks.filter((t) => t.list === l.id) })).filter((g) => g.tasks.length);

  return (
    <Page title="My Tasks">
      {view.needsAnotherGo.length > 0 && (
        <Section title="Needs another go">
          {view.needsAnotherGo.map((t) => (
            <div key={t.occurrenceId}>
              <Caption1>{dayLabel(t.periodStart)}</Caption1>
              <TaskCard task={t} names={names} meId={view.me.id} onOpen={markDone.show} />
            </div>
          ))}
        </Section>
      )}
      {groups.length === 0 && view.needsAnotherGo.length === 0 && <Empty>Nothing on your list today.</Empty>}
      {groups.map((g) => (
        <Section key={g.id} title={g.label}>
          {g.tasks.map((t) => (
            <TaskCard key={t.occurrenceId} task={t} names={names} meId={view.me.id} onOpen={markDone.show} />
          ))}
        </Section>
      ))}
      <KeptDialog dialog={markDone}>{(task) => <MarkDoneForm task={task} onClose={markDone.hide} />}</KeptDialog>
    </Page>
  );
}
