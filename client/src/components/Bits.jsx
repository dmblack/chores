import { Badge, ToggleButton, makeStyles } from '@fluentui/react-components';
import { Checkmark20Regular } from '../icons.js';

const useStyles = makeStyles({
  badge: { whiteSpace: 'nowrap', flexShrink: 0 },
});

/** Points label that never wraps inside a card header. */
export function PointsBadge({ children }) {
  return (
    <Badge appearance="tint" size="large" className={useStyles().badge}>
      {children}
    </Badge>
  );
}

/** A tap-to-pick chip whose selected state is obvious on an iPad. */
export function Chip({ checked, children, ...props }) {
  return (
    <ToggleButton
      size="large"
      shape="circular"
      appearance={checked ? 'primary' : 'secondary'}
      icon={checked ? <Checkmark20Regular /> : undefined}
      checked={checked}
      aria-pressed={checked}
      {...props}
    >
      {children}
    </ToggleButton>
  );
}
