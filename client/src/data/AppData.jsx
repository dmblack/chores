/**
 * Combine the household snapshot with this device's durable queue of unsent actions.
 * Stable action IDs allow offline work to be retried until the server acknowledges it.
 */

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError } from '../lib/api.js';
import { load, remove, save } from '../lib/storage.js';
import { connectWhileVisible, isRetryableFailure, RETRY_MS, retryDelay } from '../lib/sync.js';
import { uuid } from '../lib/util.js';
import { localDate } from '@shared/dates.js';

const SNAPSHOT_KEY = 'snapshot';
const QUEUE_KEY = 'queue';

// Refusals that just mean "someone beat you to it" rather than a real problem.
const INFO_CODES = new Set(['already_approved', 'already_pending', 'already_endorsed', 'sent_back', 'already_cancelled', 'already_declined']);

const Ctx = createContext(null);
/** Read the household view and synchronization actions from the nearest provider. */
export const useApp = () => useContext(Ctx);

/**
 * Provide cached household state, offline actions and foreground synchronization.
 * @param {{children: import('react').ReactNode}} props - Descendant application screens.
 * @returns {import('react').ReactNode} Application data context provider.
 */
export function AppDataProvider({ children }) {
  const [phase, setPhase] = useState('loading'); // loading | setup | signin | ready | unreachable
  const [snapshot, setSnapshot] = useState(null);
  const [queue, setQueueState] = useState([]);
  const [online, setOnline] = useState(true);
  const [notices, setNotices] = useState([]);
  const snapRef = useRef(null);
  const queueRef = useRef([]);
  const flushing = useRef(null);
  const retryAt = useRef(0);

  /** Persist each queue change before exposing the same queue to subsequent flushes. */
  const setQueue = useCallback((q) => {
    queueRef.current = q;
    setQueueState(q);
    save(QUEUE_KEY, q);
  }, []);

  /** Retain the latest five synchronization notices for the current screen. */
  const notify = useCallback((items) => setNotices((n) => [...n, ...items].slice(-5)), []);
  /** Remove a notice once the user dismisses it. */
  const dismissNotice = useCallback((id) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  /** Pull current state, detect signed-out sessions and fall back to the saved offline view. */
  const refresh = useCallback(async () => {
    try {
      const s = await api.get('/api/state');
      snapRef.current = s;
      setSnapshot(s);
      setOnline(true);
      setPhase('ready');
      save(SNAPSHOT_KEY, s);
      return true;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        snapRef.current = null;
        setSnapshot(null);
        setOnline(true);
        remove(SNAPSHOT_KEY);
        const status = await api.get('/api/auth/status').catch(() => ({ needsSetup: false }));
        setPhase(status.needsSetup ? 'setup' : 'signin');
        return false;
      }
      setOnline(false);
      if (!snapRef.current) {
        // Offline at launch: open with the last list this iPad saw.
        const cached = await load(SNAPSHOT_KEY);
        if (cached) {
          snapRef.current = cached;
          setSnapshot(cached);
          setPhase('ready');
        } else {
          setPhase('unreachable');
        }
      }
      return false;
    }
  }, []);

  /** Send this person's queued actions, oldest first, then pull the latest state. */
  const flush = useCallback(() => {
    if (flushing.current) return flushing.current;
    /** Foreground wakeups still refresh state while a queued write is backing off. */
    if (Date.now() < retryAt.current) return refresh();
    flushing.current = (async () => {
      const me = snapRef.current?.me?.id;
      while (me) {
        const batch = queueRef.current.filter((a) => a.userId === me).slice(0, 50);
        if (batch.length === 0) break;
        let res;
        try {
          res = await api.post('/api/actions', {
            actions: batch.map(({ id, type, payload, clientTime }) => ({ id, type, payload, clientTime })),
          });
        } catch (e) {
          if (isRetryableFailure(e)) {
            retryAt.current = Date.now() + retryDelay(e);
            setOnline(false);
          }
          else if (e instanceof ApiError && e.status !== 401) {
            // Malformed batch (shouldn't happen): drop it rather than block the queue forever.
            const sent = new Set(batch.map((a) => a.id));
            setQueue(queueRef.current.filter((a) => !sent.has(a.id)));
            notify([{ id: uuid(), tone: 'error', message: `Couldn’t save ${batch.length} change(s): ${e.message}` }]);
            continue;
          }
          break;
        }
        retryAt.current = 0;
        setOnline(true);
        const handled = new Set(res.results.map((r) => r.id));
        setQueue(queueRef.current.filter((a) => !handled.has(a.id)));
        const refused = res.results.filter((r) => r.status === 'rejected');
        if (refused.length) {
          notify(refused.map((r) => ({ id: r.id, tone: INFO_CODES.has(r.error.code) ? 'info' : 'warning', message: r.error.message })));
        }
      }
      await refresh();
    })().finally(() => {
      flushing.current = null;
    });
    return flushing.current;
  }, [refresh, setQueue, notify]);

  /** Queue an action (works offline). `meta` is for this iPad's display only. */
  const enqueue = useCallback(
    (type, payload, meta = {}) => {
      const action = { id: uuid(), userId: snapRef.current?.me?.id, type, payload, clientTime: new Date().toISOString(), meta };
      setQueue([...queueRef.current, action]);
      flush();
      return action.id;
    },
    [flush, setQueue],
  );

  /** Send an action now and wait for the answer (admin screens; needs a connection). */
  const sendNow = useCallback(
    async (type, payload) => {
      const res = await api.post('/api/actions', { actions: [{ id: uuid(), type, payload, clientTime: new Date().toISOString() }] });
      const r = res.results[0];
      if (r.status === 'rejected') throw new ApiError(400, { error: r.error });
      await refresh();
      return r;
    },
    [refresh],
  );

  /** Authenticate, refresh the signed-in user's state and resume their saved actions. */
  const signIn = useCallback(
    async (path, body) => {
      await api.post(path, body);
      location.hash = '/'; // whoever signs in starts on their own home screen
      await refresh();
      flush();
    },
    [refresh, flush],
  );

  /** End the session and clear this person's cached view and pending actions. */
  const signOut = useCallback(async () => {
    await api.post('/api/auth/logout');
    const me = snapRef.current?.me?.id;
    setQueue(queueRef.current.filter((a) => a.userId !== me));
    snapRef.current = null;
    setSnapshot(null);
    remove(SNAPSHOT_KEY);
    location.hash = '/';
    setPhase('signin');
  }, [setQueue]);

  /** Restore the durable queue before the first refresh or attempted submission. */
  useEffect(() => {
    (async () => {
      const q = (await load(QUEUE_KEY)) ?? [];
      queueRef.current = q;
      setQueueState(q);
      if (await refresh()) flush();
    })();
  }, [refresh, flush]);

  /** Live updates use a connection only while this PWA is in the foreground. */
  useEffect(() => {
    if (phase !== 'ready' || !online) return undefined;
    return connectWhileVisible(document, () => {
      const es = new EventSource('/api/stream');
      let timer = null;
      /** Refresh once after a burst of server notifications. */
      es.onmessage = (ev) => {
        try {
          const { seq } = JSON.parse(ev.data);
          if (seq === snapRef.current?.seq) return;
        } catch {
          // A malformed notification still warrants refreshing the current state.
        }
        clearTimeout(timer);
        timer = setTimeout(refresh, 150);
      };
      /** Closing a hidden or unmounted page also cancels its pending refresh. */
      return () => {
        clearTimeout(timer);
        es.close();
      };
    });
  }, [phase, online, refresh]);

  /** Retry visible pages every fifteen seconds and refresh immediately when the page resumes. */
  useEffect(() => {
    /** Skip hidden pages and synchronize stale, offline or pending household views. */
    const tick = () => {
      if (document.visibilityState === 'hidden') return;
      const s = snapRef.current;
      if (!s) refresh();
      else if (!online || queueRef.current.length > 0 || s.today !== localDate()) flush();
    };
    const id = setInterval(tick, RETRY_MS);
    /** Refresh after foreground or network changes, retaining any active write backoff. */
    const wake = () => {
      if (document.visibilityState !== 'hidden') (snapRef.current ? flush() : refresh());
    };
    window.addEventListener('online', wake);
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(id);
      window.removeEventListener('online', wake);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [online, refresh, flush]);

  const view = useMemo(() => (snapshot ? withQueue(snapshot, queue) : null), [snapshot, queue]);

  const value = useMemo(
    () => ({ phase, view, online, queue, notices, dismissNotice, refresh, flush, enqueue, sendNow, signIn, signOut }),
    [phase, view, online, queue, notices, dismissNotice, refresh, flush, enqueue, sendNow, signIn, signOut],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Show this iPad's unsent actions on top of the last server state. */
function withQueue(s, queue) {
  const mine = queue.filter((a) => a.userId === s.me.id);
  if (mine.length === 0) return s;
  const submits = new Map();
  const decisions = new Map(); // completionId / redemptionId -> action type
  const requests = [];
  for (const a of mine) {
    if (a.type === 'completion.submit') submits.set(a.meta.occurrenceId, a);
    else if (a.type === 'completion.approve' || a.type === 'completion.sendBack') decisions.set(a.payload.completionId, a.type);
    else if (a.type.startsWith('redemption.') && a.type !== 'redemption.request') decisions.set(a.payload.redemptionId, a.type);
    else if (a.type === 'redemption.request') requests.push(a);
  }
  /** Overlay a pending completion without changing the cached server task. */
  const markTask = (t) => {
    const a = submits.get(t.occurrenceId);
    return a ? { ...t, status: 'pending', queued: true, queuedContributorIds: a.payload.contributorIds } : t;
  };
  /** Indicate a locally queued decision until the server acknowledges its action ID. */
  const markDecision = (c) => (decisions.has(c.id) ? { ...c, queued: decisions.get(c.id) } : c);
  const waiting = s.approve.waiting.map(markDecision);
  const rewardRequests = s.approve.rewardRequests.map(markDecision);
  const held = requests.reduce((sum, a) => sum + (a.meta.cost ?? 0), 0);
  return {
    ...s,
    myTasks: s.myTasks.map(markTask),
    needsAnotherGo: s.needsAnotherGo.filter((t) => !submits.has(t.occurrenceId)),
    approve: {
      ...s.approve,
      waiting,
      endorse: s.approve.endorse.map(markDecision),
      rewardRequests,
      badge: waiting.filter((c) => !c.queued).length + rewardRequests.filter((r) => !r.queued).length,
    },
    points: { ...s.points, available: s.points.available - held },
    myRedemptions: [
      ...requests.map((a) => ({ id: a.payload.redemptionId, rewardName: a.meta.label, cost: a.meta.cost, status: 'pending', requestedAt: a.clientTime, queued: true })),
      ...s.myRedemptions.map(markDecision),
    ],
  };
}
