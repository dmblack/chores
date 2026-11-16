import {
  Avatar,
  Button,
  Menu,
  MenuDivider,
  MenuGroup,
  MenuGroupHeader,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
} from '@fluentui/react-components';
import {
  Gift24Regular,
  People24Regular,
  PersonCircle24Regular,
  Settings24Regular,
  SignOut24Regular,
  TaskListSquareLtr24Regular,
} from '@fluentui/react-icons';
import { useApp } from '../data/AppData.jsx';
import { go } from '../lib/router.js';

/**
 * Everything that isn't My Tasks or Approve lives behind your avatar:
 * Rewards and Profile for everyone, the admin pages for grown-ups, and
 * Switch person.
 */
export function UserMenu() {
  const { view, online, queue, signOut } = useApp();
  const { me } = view;
  const unsent = queue.some((a) => a.userId === me.id);

  // Switching needs the server, and mustn't strand unsent changes; Profile explains why when it can't.
  const switchPerson = () => (online && !unsent ? signOut().catch(() => go('/profile')) : go('/profile'));

  return (
    <Menu positioning="below-end">
      <MenuTrigger disableButtonEnhancement>
        <Button appearance="transparent" shape="circular" aria-label={`Menu for ${me.nickname}`} style={{ padding: 0, minWidth: 0 }}>
          <Avatar name={me.nickname} color="colorful" size={40} />
        </Button>
      </MenuTrigger>
      <MenuPopover>
        <MenuList>
          <MenuGroup>
            <MenuGroupHeader>{me.nickname}</MenuGroupHeader>
            <MenuItem icon={<Gift24Regular />} onClick={() => go('/rewards')}>Rewards</MenuItem>
            <MenuItem icon={<PersonCircle24Regular />} onClick={() => go('/profile')}>Profile</MenuItem>
          </MenuGroup>
          {me.role === 'grownup' && (
            <>
              <MenuDivider />
              <MenuGroup>
                <MenuGroupHeader>Grown-ups</MenuGroupHeader>
                <MenuItem icon={<TaskListSquareLtr24Regular />} onClick={() => go('/manage')}>Manage tasks</MenuItem>
                <MenuItem icon={<People24Regular />} onClick={() => go('/people')}>People</MenuItem>
                <MenuItem icon={<Settings24Regular />} onClick={() => go('/settings')}>Settings</MenuItem>
              </MenuGroup>
            </>
          )}
          <MenuDivider />
          <MenuItem icon={<SignOut24Regular />} onClick={switchPerson}>Switch person</MenuItem>
        </MenuList>
      </MenuPopover>
    </Menu>
  );
}
