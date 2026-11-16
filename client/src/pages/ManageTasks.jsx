import { Badge, Button, Caption1, Card, CardHeader, Text, makeStyles, tokens } from '@fluentui/react-components';
import { Add24Regular, ChevronRight24Regular } from '@fluentui/react-icons';
import { LISTS, advancedSummary } from '@shared/rules.js';
import { describeRepeat } from '@shared/schedule.js';
import { useApp } from '../data/AppData.jsx';
import { Empty, Page, Section } from '../components/Page.jsx';
import { go } from '../lib/router.js';
import { pts } from '../lib/util.js';

const useStyles = makeStyles({
  card: { padding: tokens.spacingHorizontalL },
  meta: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, alignItems: 'center' },
});

export function ManageTasks() {
  const s = useStyles();
  const { view } = useApp();
  const tasks = view.tasks ?? [];
  return (
    <Page
      title="Manage tasks"
      actions={<Button size="large" appearance="primary" icon={<Add24Regular />} onClick={() => go('/manage/new')}>New task</Button>}
    >
      {tasks.length === 0 && <Empty>No tasks yet. Add the first one with “New task”.</Empty>}
      {LISTS.map((l) => {
        const inList = tasks.filter((t) => t.list === l.id).sort((a, b) => a.name.localeCompare(b.name));
        return (
          <Section
            key={l.id}
            title={l.label}
            action={<Button appearance="subtle" icon={<Add24Regular />} onClick={() => go(`/manage/new?list=${l.id}`)}>Add</Button>}
          >
            {inList.length === 0 && <Caption1>No {l.label.toLowerCase()} tasks.</Caption1>}
            {inList.map((t) => {
              const summary = advancedSummary(t);
              return (
                <Card key={t.id} className={s.card} onClick={() => go(`/manage/${t.id}`)}>
                  <CardHeader
                    header={<Text size={400} weight="semibold">{t.name}</Text>}
                    description={
                      <div className={s.meta}>
                        <Caption1>{describeRepeat(t.repeat)}</Caption1>
                        <Caption1>· {pts(t.points)}</Caption1>
                        <Badge appearance="outline" color={t.kind === 'personal' ? 'informative' : 'brand'}>
                          {t.kind === 'personal' ? 'Everyone does their own' : 'Household job'}
                        </Badge>
                        {summary && <Caption1>· {summary}</Caption1>}
                      </div>
                    }
                    action={<ChevronRight24Regular />}
                  />
                </Card>
              );
            })}
          </Section>
        );
      })}
    </Page>
  );
}
