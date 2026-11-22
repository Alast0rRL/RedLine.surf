import { memo, useMemo, type ReactNode } from 'react';
import { EventStatus, EventType, MsgType, type MatrixClient, type MatrixEvent, type Room } from 'matrix-js-sdk';
import { formatTime, isPendingDecryption, isUndecryptable, isVoice, previewText } from '../lib/events';
import { sanitizeMatrixHtml, stripReplyFallback } from '../lib/html';
import type { MediaSource } from '../lib/media';
import { findRenderer, isBotStyled, isBotUser } from '../bots/registry';
import { Avatar, Icon } from '../components/ui';
import { ImageMessage } from './ImageMessage';
import { VoicePlayer } from './VoicePlayer';

const URL_RE = /(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

/** Простой текст: переносы строк + кликабельные ссылки. */
function Linkified({ text }: { text: string }) {
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((p, i) =>
        i % 2 === 1 ? (
          <a key={i} href={p} target="_blank" rel="noopener noreferrer nofollow">{p}</a>
        ) : (
          p
        ),
      )}
    </>
  );
}

function Body({ ev }: { ev: MatrixEvent }) {
  const content = ev.getContent();
  const html = useMemo(
    () => (content.format === 'org.matrix.custom.html' && typeof content.formatted_body === 'string'
      ? sanitizeMatrixHtml(content.formatted_body)
      : null),
    [content.format, content.formatted_body],
  );
  if (html) return <div className="msg-text msg-text--html" dangerouslySetInnerHTML={{ __html: html }} />;
  const body = stripReplyFallback(String(content.body ?? ''));
  // одни эмодзи — крупно
  const onlyEmoji = /^(\p{Extended_Pictographic}|\p{Emoji_Component}|\s){1,8}$/u.test(body) && !/\d/.test(body);
  return (
    <div className={`msg-text${onlyEmoji ? ' msg-text--emoji' : ''}`}>
      {content.msgtype === MsgType.Emote && <em>* {ev.sender?.name} </em>}
      <Linkified text={body} />
    </div>
  );
}

function ReplyQuote({ room, ev }: { room: Room; ev: MatrixEvent }) {
  const replyTo = ev.replyEventId;
  if (!replyTo) return null;
  const target = room.findEventById(replyTo);
  return (
    <div className="msg-reply">
      <span className="msg-reply__who">{target ? target.sender?.name ?? target.getSender() : 'Сообщение'}</span>
      <span className="msg-reply__text">{target ? previewText(target) : 'не загружено'}</span>
    </div>
  );
}

function Status({ client, room, ev, readByOthers }: { client: MatrixClient; room: Room; ev: MatrixEvent; readByOthers: boolean }) {
  const s = ev.status;
  if (s === EventStatus.NOT_SENT) {
    return (
      <span className="msg-status msg-status--failed">
        <Icon name="alert" size={14} />
        <button type="button" onClick={() => void client.resendEvent(ev, room)}>Повторить</button>
        <button type="button" onClick={() => client.cancelPendingEvent(ev)} aria-label="Удалить">
          <Icon name="trash" size={14} />
        </button>
      </span>
    );
  }
  if (s === EventStatus.SENDING || s === EventStatus.QUEUED || s === EventStatus.ENCRYPTING) {
    return <span className="msg-status" aria-label="Отправляется"><Icon name="clock" size={13} /></span>;
  }
  return (
    <span className={`msg-status${readByOthers ? ' msg-status--read' : ''}`} aria-label={readByOthers ? 'Прочитано' : 'Доставлено'}>
      <Icon name={readByOthers ? 'checks' : 'check'} size={14} />
    </span>
  );
}

function Content({ ev }: { ev: MatrixEvent }): ReactNode {
  if (ev.isRedacted()) return <div className="msg-text msg-text--muted">Сообщение удалено</div>;
  if (isUndecryptable(ev)) {
    return (
      <div className="msg-text msg-text--muted">
        <Icon name="lock" size={14} /> Не удалось расшифровать. Введите фразу восстановления в настройках
      </div>
    );
  }
  if (isPendingDecryption(ev)) return <div className="msg-text msg-text--muted"><Icon name="lock" size={14} /> Расшифровка…</div>;

  const custom = findRenderer(ev);
  if (custom) {
    const C = custom.component;
    return <C event={ev} />;
  }

  const c = ev.getContent();
  const src: MediaSource = { url: c.url, file: c.file, mimetype: c.info?.mimetype };
  if (ev.getType() === EventType.Sticker || c.msgtype === MsgType.Image) {
    return <ImageMessage src={src} w={c.info?.w} h={c.info?.h} alt={c.body ?? 'Фото'} />;
  }
  if (c.msgtype === MsgType.Audio) {
    const audio = c['org.matrix.msc1767.audio'] ?? {};
    return <VoicePlayer src={src} durationMs={audio.duration ?? c.info?.duration} waveform={isVoice(ev) ? audio.waveform : undefined} />;
  }
  if (c.msgtype === MsgType.File || c.msgtype === MsgType.Video) {
    return <div className="msg-text">📎 {c.body ?? 'Файл'} <span className="msg-text--muted">(откройте в Element)</span></div>;
  }
  return <Body ev={ev} />;
}

export interface MessageProps {
  client: MatrixClient;
  room: Room;
  ev: MatrixEvent;
  own: boolean;
  /** первое сообщение в серии от одного автора — показываем имя */
  first: boolean;
  /** последнее в серии — показываем аватар */
  last: boolean;
  showSenderName: boolean;
  readByOthers: boolean;
  /**
   * MatrixEvent мутируется на месте (статус, расшифровка, правки) — memo не заметит.
   * stamp меняется вместе с ним и заставляет перерисовать именно это сообщение.
   */
  stamp: string;
}

export function messageStamp(ev: MatrixEvent): string {
  return [ev.status, ev.getType(), ev.isRedacted(), ev.isDecryptionFailure(), ev.isBeingDecrypted(), ev.replacingEventId(), ev.getId()].join('|');
}

export const Message = memo(function Message({ client, room, ev, own, first, last, showSenderName, readByOthers }: MessageProps) {
  const bot = !own && isBotStyled(ev);
  const sender = ev.sender;
  const name = sender?.name ?? ev.getSender() ?? '';
  const isMedia = !ev.isRedacted() && [MsgType.Image].includes(ev.getContent().msgtype as MsgType);
  const isAudio = !ev.isRedacted() && ev.getContent().msgtype === MsgType.Audio;
  const edited = !!ev.replacingEventId();

  return (
    <div className={`msg${own ? ' msg--own' : ''}${first ? ' msg--first' : ''}${last ? ' msg--last' : ''}${bot ? ' msg--bot' : ''}`}>
      {!own && (
        <div className="msg__avatar">
          {last && (
            <Avatar client={client} name={name} seed={ev.getSender() ?? ''} mxc={sender?.getMxcAvatarUrl()} size="sm" />
          )}
        </div>
      )}
      <div className={`bubble${isMedia ? ' bubble--media' : ''}${isAudio ? ' bubble--audio' : ''}`}>
        {(bot || (showSenderName && first && !own)) && (
          <div className="bubble__sender">
            {name}
            {isBotUser(ev.getSender()) && <span className="bot-tag"><Icon name="bot" size={11} /> бот</span>}
          </div>
        )}
        <ReplyQuote room={room} ev={ev} />
        <Content ev={ev} />
        <div className="bubble__meta">
          {edited && <span className="bubble__edited">изм.</span>}
          <time dateTime={new Date(ev.getTs()).toISOString()}>{formatTime(ev.getTs())}</time>
          {own && <Status client={client} room={room} ev={ev} readByOthers={readByOthers} />}
        </div>
      </div>
    </div>
  );
});
