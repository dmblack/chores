import { Dialog, DialogSurface } from '@fluentui/react-components';

/**
 * A Fluent Dialog driven by useDialog(): it stays mounted and closes through
 * `open`, and its body is re-created (fresh form state) each time it opens.
 *   <KeptDialog dialog={d}>{(data) => <MyForm item={data} onClose={d.hide} />}</KeptDialog>
 */
export function KeptDialog({ dialog, children }) {
  return (
    <Dialog open={dialog.open} onOpenChange={(_, d) => !d.open && dialog.hide()}>
      <DialogSurface>{dialog.data != null && <Body key={dialog.key}>{children(dialog.data)}</Body>}</DialogSurface>
    </Dialog>
  );
}

const Body = ({ children }) => children;
