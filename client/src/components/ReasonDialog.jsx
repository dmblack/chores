import { useEffect, useState } from 'react';
import {
  Button,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Field,
  Text,
  Textarea,
  makeStyles,
  tokens,
} from '@fluentui/react-components';
import { Chip } from './Bits.jsx';

const useStyles = makeStyles({
  chips: { display: 'flex', flexWrap: 'wrap', gap: tokens.spacingHorizontalS, marginBlock: tokens.spacingVerticalM },
});

/** Pick one or more reasons and/or type what still needs doing. At least one is required. */
export function ReasonDialog({ open, title, intro, reasons, noteLabel, confirmLabel, onCancel, onConfirm }) {
  const s = useStyles();
  const [picked, setPicked] = useState([]);
  const [note, setNote] = useState('');
  useEffect(() => {
    if (open) {
      setPicked([]);
      setNote('');
    }
  }, [open]);
  const toggle = (id) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const ready = picked.length > 0 || note.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={(_, d) => !d.open && onCancel()}>
      <DialogSurface>
        <DialogBody>
          <DialogTitle>{title}</DialogTitle>
          <DialogContent>
            {intro && <Text block>{intro}</Text>}
            <div className={s.chips} role="group" aria-label="Reasons">
              {reasons.map((r) => (
                <Chip key={r.id} checked={picked.includes(r.id)} onClick={() => toggle(r.id)}>
                  {r.label}
                </Chip>
              ))}
            </div>
            <Field label={noteLabel}>
              <Textarea value={note} onChange={(_, d) => setNote(d.value)} maxLength={500} resize="vertical" />
            </Field>
          </DialogContent>
          <DialogActions>
            <Button size="large" onClick={onCancel}>Cancel</Button>
            <Button size="large" appearance="primary" disabled={!ready} onClick={() => onConfirm({ reasons: picked, note: note.trim() })}>
              {confirmLabel}
            </Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  );
}

export function reasonText(reasons = [], note = '', options = []) {
  const labels = reasons.map((id) => options.find((o) => o.id === id)?.label).filter(Boolean);
  return [...labels, note].filter(Boolean).join(' · ');
}
