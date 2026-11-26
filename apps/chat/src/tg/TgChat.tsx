import { useCallback, useState } from 'react';
import { Button, Icon } from '../components/ui';
import { navigate } from '../hooks/useHashRoute';
import { ChatTimeline } from '../chat/ChatTimeline';
import { ChatComposer, type ComposerContext } from '../chat/ChatComposer';
import type { ChatMessage } from '../chat/types';
import { TgAvatar } from './TgAvatar';
import { useTgChat } from './backend';

function typingText(names: string[], group: boolean): string {
  if (!names.length) return '';
  if (!group) return 'печатает…';
  if (names.length === 1) return `${names[0]} печатает…`;
  return `${names.slice(0, 2).join(', ')}${names.length > 2 ? ' и другие' : ''} печатают…`;
}

/** Переписка Telegram на общих компонентах чата: те же пузыри, меню, голосовые и вложения. */
export function TgChat({ peerId, ready }: { peerId: number; ready: boolean }) {
  const { state, backend, info } = useTgChat(peerId, ready);
  const [context, setContext] = useState<ComposerContext>(null);
  const onReply = useCallback((m: ChatMessage) => setContext({ kind: 'reply', m }), []);
  const onEdit = useCallback((m: ChatMessage) => setContext({ kind: 'edit', m }), []);
  const clearContext = useCallback(() => setContext(null), []);

  const name = info?.name ?? '';
  const typing = typingText(state.typing, info?.group ?? false);
  return (
    <section className="pane pane--room pane--chat" aria-label={name || 'Telegram'}>
      <header className="topbar topbar--room">
        <Button variant="ghost" icon aria-label="Назад к чатам" className="topbar__back" onClick={() => navigate.back('#/tg')}>
          <Icon name="back" />
        </Button>
        {info ? <TgAvatar peerId={peerId} name={name} size="sm" /> : null}
        <span className="topbar__title">
          <span className="topbar__name">{name}</span>
          <span className={`topbar__sub${typing ? ' is-typing' : ''}`}>{typing || 'Telegram'}</span>
        </span>
      </header>
      <ChatTimeline key={peerId} backend={backend} state={state} onReply={onReply} onEdit={onEdit} />
      {info && !info.canWrite ? (
        <div className="composer-box"><div className="composer composer--readonly"><span className="composer__readonly">Писать в этот канал могут только администраторы</span></div></div>
      ) : (
        <ChatComposer key={peerId} backend={backend} context={context} onClearContext={clearContext} />
      )}
    </section>
  );
}
