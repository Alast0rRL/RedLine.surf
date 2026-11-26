/** Аватарка с тем же DOM, что и rl-avatar из components/ui, но без Matrix-клиента. */
import { avatarColor, initials } from '@redline/ui';

type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

export function ChatAvatar({
  name,
  seed,
  src,
  size = 'md',
  round,
  status,
}: {
  name: string;
  seed: string;
  src?: string | null;
  size?: AvatarSize;
  round?: boolean;
  status?: 'online';
}) {
  return (
    <span
      className={cx('rl-avatar', size !== 'md' && `rl-avatar--${size}`, round && 'rl-avatar--round')}
      data-color={avatarColor(seed)}
      aria-hidden="true"
    >
      {src ? <img src={src} alt="" draggable={false} /> : initials(name)}
      {status && <span className="rl-avatar__status" data-status={status} />}
    </span>
  );
}
