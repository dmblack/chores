import { Badge, Button, MessageBar, MessageBarActions, MessageBarBody, Text, Title2, makeStyles, tokens } from '@fluentui/react-components';
import { ArrowLeft24Regular, CloudArrowUp24Regular, Dismiss24Regular, WifiOff24Regular } from '../icons.js';
import { localDate } from '@shared/dates.js';
import { useApp } from '../data/AppData.jsx';
import { go } from '../lib/router.js';
import { dayLabel } from '../lib/util.js';

const useStyles = makeStyles({
  page: {
    maxWidth: '760px',
    margin: '0 auto',
    padding: `max(16px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) 48px max(16px, env(safe-area-inset-left))`,
    boxSizing: 'border-box',
  },
  header: { display: 'flex', alignItems: 'center', gap: tokens.spacingHorizontalS, minHeight: '48px', marginBottom: tokens.spacingVerticalM },
  title: { flexGrow: 1, minWidth: 0 },
  status: { display: 'flex', gap: tokens.spacingHorizontalS, alignItems: 'center', flexShrink: 0 },
  notices: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalM },
});

export function Page({ title, back = '/', actions, children }) {
  const s = useStyles();
  const { online, queue, view, notices, dismissNotice } = useApp();
  const unsent = view ? queue.filter((a) => a.userId === view.me.id).length : 0;
  const stale = view && view.today !== localDate();
  return (
    <div className={s.page}>
      <header className={s.header}>
        {back && <Button appearance="subtle" size="large" icon={<ArrowLeft24Regular />} aria-label="Back" onClick={() => go(back)} />}
        {title ? <Title2 as="h1" className={s.title}>{title}</Title2> : <span className={s.title} />}
        <div className={s.status}>
          {!online && (
            <Badge appearance="tint" color="warning" size="large" icon={<WifiOff24Regular />}>Offline</Badge>
          )}
          {unsent > 0 && (
            <Badge appearance="tint" color="informative" size="large" icon={<CloudArrowUp24Regular />}>{unsent} to send</Badge>
          )}
          {actions}
        </div>
      </header>
      {(notices.length > 0 || stale) && (
        <div className={s.notices}>
          {stale && (
            <MessageBar intent="warning">
              <MessageBarBody>Showing the list from {dayLabel(view.today).toLowerCase()} until this iPad reconnects.</MessageBarBody>
            </MessageBar>
          )}
          {notices.map((n) => (
            <MessageBar key={n.id} intent={n.tone}>
              <MessageBarBody>{n.message}</MessageBarBody>
              <MessageBarActions
                containerAction={<Button appearance="transparent" icon={<Dismiss24Regular />} aria-label="Dismiss" onClick={() => dismissNotice(n.id)} />}
              />
            </MessageBar>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}

const useSectionStyles = makeStyles({
  section: { display: 'flex', flexDirection: 'column', gap: tokens.spacingVerticalS, marginBottom: tokens.spacingVerticalXXL },
  heading: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: tokens.spacingHorizontalS, marginBottom: tokens.spacingVerticalXS },
});

export function Section({ title, action, children }) {
  const s = useSectionStyles();
  return (
    <section className={s.section}>
      {(title || action) && (
        <div className={s.heading}>
          <Text as="h2" size={500} weight="semibold">{title}</Text>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

const useEmptyStyles = makeStyles({
  empty: {
    padding: tokens.spacingVerticalXXL,
    textAlign: 'center',
    color: tokens.colorNeutralForeground3,
    border: `1px dashed ${tokens.colorNeutralStroke2}`,
    borderRadius: tokens.borderRadiusLarge,
  },
});

export function Empty({ children }) {
  return <div className={useEmptyStyles().empty}>{children}</div>;
}
