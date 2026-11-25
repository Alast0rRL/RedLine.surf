import { Avatar } from '../components/ui';
import { useTgAvatar } from './hooks';

/** Аватар Telegram: фото профиля, пока грузится — инициалы. */
export function TgAvatar({ peerId, name, size, ready = true }: { peerId: number; name: string; size?: 'sm' | 'md'; ready?: boolean }) {
  const src = useTgAvatar(peerId, ready);
  return <Avatar name={name || '?'} seed={`tg:${peerId}`} size={size} src={src} round />;
}
