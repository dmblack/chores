import { useCallback, useState } from 'react';

/**
 * Dialog state that closes through Fluent's `open` prop instead of unmounting.
 * Unmounting an open Fluent Dialog can leave the app root aria-hidden if
 * another dialog opens straight after, which hides the whole app from
 * VoiceOver. `data` is kept while the dialog animates closed.
 */
export function useDialog() {
  const [state, setState] = useState({ open: false, data: null, seq: 0 });
  const show = useCallback((data) => setState((s) => ({ open: true, data, seq: s.seq + 1 })), []);
  const hide = useCallback(() => setState((s) => ({ ...s, open: false })), []);
  return { open: state.open, data: state.data, key: state.seq, show, hide };
}
