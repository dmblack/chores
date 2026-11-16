import { Button, Caption1, CounterBadge, ProgressBar, Text, makeStyles, tokens } from '@fluentui/react-components';
import { CheckmarkCircle24Regular, Star24Filled, TaskListLtr24Regular } from '../icons.js';
import { useApp } from '../data/AppData.jsx';
import { Page } from '../components/Page.jsx';
import { UserMenu } from '../components/UserMenu.jsx';
import { go } from '../lib/router.js';

const useStyles = makeStyles({
  progress: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalXS, marginBottom: tokens.spacingVerticalL },
  big: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: tokens.spacingHorizontalL },
  bigButton: {
    position: 'relative',
    minHeight: '168px',
    flexDirection: 'column',
    gap: tokens.spacingVerticalS,
    fontSize: tokens.fontSizeBase600,
    borderRadius: tokens.borderRadiusXLarge,
  },
  bigIcon: { fontSize: '48px', width: '48px', height: '48px', '& svg': { width: '48px', height: '48px' } },
  sub: { fontSize: tokens.fontSizeBase300, fontWeight: tokens.fontWeightRegular, opacity: 0.85 },
  badge: { position: 'absolute', top: '12px', right: '12px' },
  balance: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalXS, color: tokens.colorPaletteMarigoldForeground1 },
});

/** The landing page: My Tasks and Approve, today's progress, and everything else behind your avatar. */
export function Home() {
  const s = useStyles();
  const { view } = useApp();
  const { me, progress, approve, myTasks, needsAnotherGo, points } = view;
  const todo = myTasks.filter((t) => t.status === 'todo' || t.status === 'sentBack').length + needsAnotherGo.length;
  const allDone = progress.total > 0 && progress.approved === progress.total;

  return (
    <Page
      back={false}
      actions={
        <>
          <Button appearance="subtle" size="large" onClick={() => go('/rewards')} aria-label={`${points.balance} points, rewards`}>
            <span className={s.balance}><Star24Filled /> <Text size={500} weight="semibold">{points.balance}</Text></span>
          </Button>
          <UserMenu />
        </>
      }
    >
      {progress.total > 0 && (
        <div className={s.progress}>
          <ProgressBar
            value={progress.approved / progress.total}
            thickness="large"
            shape="rounded"
            color={allDone ? 'success' : 'brand'}
            aria-label="Today’s progress"
          />
          <Caption1>{progress.approved} of {progress.total} approved today</Caption1>
        </div>
      )}

      <div className={s.big}>
        <Button appearance="primary" size="large" className={s.bigButton} icon={{ children: <TaskListLtr24Regular />, className: s.bigIcon }} onClick={() => go('/tasks')}>
          My Tasks
          <span className={s.sub}>{todo === 0 ? 'All done for now' : `${todo} to do`}</span>
        </Button>
        <Button appearance="primary" size="large" className={s.bigButton} icon={{ children: <CheckmarkCircle24Regular />, className: s.bigIcon }} onClick={() => go('/approve')}>
          Approve
          <span className={s.sub}>{approve.badge === 0 ? 'Nothing waiting' : 'Waiting for a tick'}</span>
          {approve.badge > 0 && <CounterBadge className={s.badge} count={approve.badge} color="danger" size="extra-large" aria-label={`${approve.badge} waiting`} />}
        </Button>
      </div>
    </Page>
  );
}
