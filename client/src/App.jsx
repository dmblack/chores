import { useEffect, useState } from 'react';
import { FluentProvider, Spinner, makeStyles, tokens, webDarkTheme, webLightTheme } from '@fluentui/react-components';
import { AppDataProvider, useApp } from './data/AppData.jsx';
import { useRoute } from './lib/router.js';
import { Login, Unreachable } from './pages/Login.jsx';
import { Home } from './pages/Home.jsx';
import { MyTasks } from './pages/MyTasks.jsx';
import { Approve } from './pages/Approve.jsx';
import { Rewards } from './pages/Rewards.jsx';
import { ManageTasks } from './pages/ManageTasks.jsx';
import { TaskEditor } from './pages/TaskEditor.jsx';
import { People } from './pages/People.jsx';
import { Profile } from './pages/Profile.jsx';
import { Settings } from './pages/Settings.jsx';

const useStyles = makeStyles({
  root: { minHeight: '100dvh', backgroundColor: tokens.colorNeutralBackground2 },
  loading: { minHeight: '100dvh', display: 'flex', alignItems: 'center', justifyContent: 'center' },
});

function usePrefersDark() {
  const query = '(prefers-color-scheme: dark)';
  const [dark, setDark] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return undefined;
    const onChange = (e) => setDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return dark;
}

/**
 * Fluent's modal dialogs mark #root aria-hidden while open. If a dialog is
 * unmounted mid-close (say, Save then Back straight away), that attribute can
 * be left behind and the whole app disappears for VoiceOver. Clear it whenever
 * no dialog is left on the page.
 */
function useModalCleanup() {
  useEffect(() => {
    const root = document.getElementById('root');
    let timer;
    const check = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const dialogOpen = document.querySelector('.fui-DialogSurface, [role="dialog"], [role="alertdialog"]');
        if (!dialogOpen && root?.getAttribute('aria-hidden') === 'true') root.removeAttribute('aria-hidden');
      }, 300);
    };
    const mo = new MutationObserver(check);
    mo.observe(document.body, { childList: true }); // dialog portals come and go as children of <body>
    if (root) mo.observe(root, { attributes: true, attributeFilter: ['aria-hidden'] });
    window.addEventListener('hashchange', check);
    return () => {
      clearTimeout(timer);
      mo.disconnect();
      window.removeEventListener('hashchange', check);
    };
  }, []);
}

function Screens() {
  const s = useStyles();
  const { phase, view } = useApp();
  const { path, params } = useRoute();

  if (phase === 'loading') return <div className={s.loading}><Spinner size="large" /></div>;
  if (phase === 'setup') return <Login setup />;
  if (phase === 'signin') return <Login />;
  if (phase === 'unreachable' || !view) return <Unreachable />;

  const grownup = view.me.role === 'grownup';
  if (path === '/tasks') return <MyTasks />;
  if (path === '/approve') return <Approve />;
  if (path === '/rewards') return <Rewards />;
  if (path === '/profile') return <Profile />;
  if (grownup && path === '/manage') return <ManageTasks />;
  if (grownup && path === '/manage/new') return <TaskEditor key="new" list={params.get('list')} />;
  if (grownup && path.startsWith('/manage/')) return <TaskEditor key={path} taskId={path.slice('/manage/'.length)} />;
  if (grownup && path === '/people') return <People />;
  if (grownup && path === '/settings') return <Settings />;
  return <Home />;
}

export function App() {
  const s = useStyles();
  const dark = usePrefersDark();
  useModalCleanup();
  useEffect(() => {
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1f1f1f' : '#fafafa');
  }, [dark]);
  return (
    // The page background sits on an inner div: Fluent copies the provider's own
    // classes onto menu/dialog portal layers, and a full-height background there
    // would cover the page whenever a menu opens.
    <FluentProvider theme={dark ? webDarkTheme : webLightTheme}>
      <div className={s.root}>
        <AppDataProvider>
          <Screens />
        </AppDataProvider>
      </div>
    </FluentProvider>
  );
}
