/**
 * Общая модель чата: один интерфейс для Matrix и Telegram.
 * Компоненты из src/chat/ знают только эти типы; всё, что зависит от протокола, — в ChatBackend.
 */
import type { MouseEvent, ReactNode } from 'react';
import type { VoiceRecording } from '../lib/voice/recorder';

export type ChatMediaKind = 'image' | 'video' | 'voice' | 'audio' | 'file' | 'sticker';

export interface ChatMedia {
  kind: ChatMediaKind;
  /** Непрозрачная ссылка для backend.mediaUrl (mxc, файл Telegram и т. п.). */
  ref: unknown;
  /** Отдельная ссылка на превью (миниатюра фото/видео), если есть. */
  thumbRef?: unknown;
  name?: string;
  size?: number;
  mime?: string;
  w?: number;
  h?: number;
  durationMs?: number;
  /** 0..1, для голосовых */
  waveform?: number[];
}

export interface ChatReaction {
  key: string;
  count: number;
  own: boolean;
}

/** sending — ещё летит, sent — одна галочка, read — две, failed — не ушло. */
export type ChatStatus = 'sending' | 'sent' | 'read' | 'failed';

export interface ChatReplyRef {
  id: string;
  senderName: string;
  /** превью текста или подпись медиа */
  text: string;
}

export interface ChatMessage {
  id: string;
  senderId: string;
  senderName: string;
  own: boolean;
  /** мс с 1970 */
  ts: number;
  text: string;
  /** безопасный HTML (уже очищенный), если есть форматирование */
  html?: string | null;
  media?: ChatMedia | null;
  reply?: ChatReplyRef | null;
  reactions: ChatReaction[];
  edited: boolean;
  status?: ChatStatus;
  forwardedFrom?: string | null;
  /** служебное сообщение («X вступил в группу») — рисуется по центру */
  service?: string | null;
  /** упоминает меня — подсветка */
  mentionsMe?: boolean;
  /** бот — значок «бот» */
  bot?: boolean;
  /** вместо текста — заглушка шифрования */
  placeholder?: 'decrypting' | 'undecryptable' | null;
  /** сообщение рисует сам backend (карточки ботов): backend.renderCustom */
  custom?: boolean;
  /** только «служебный» вид бота: пузырь в стиле бота */
  botStyled?: boolean;
  /** картинка отправителя уже разрезолвлена backend; undefined — спросить backend.avatarUrl */
  senderAvatar?: string | null;
  /** показывать аватар: по умолчанию только в группах */
  showAvatar?: boolean;
  /** меню и жесты доступны не для всех событий (например, шифрование) */
  actionable?: boolean;
}

/** Участник для автодополнения @упоминаний. */
export interface ChatMentionCandidate {
  id: string;
  name: string;
  /** то, что показать второй строкой (логин) */
  hint?: string;
  avatarSeed: string;
}

/** Загрузка в процессе: пузырь с прогрессом внизу ленты. */
export interface ChatUpload {
  id: string;
  kind: 'image' | 'voice' | 'file';
  previewUrl?: string;
  durationMs?: number;
  name?: string;
  size?: number;
  /** 0..1 */
  progress: number;
  error?: string;
  retry?: () => void;
  cancel?: () => void;
}

export interface ChatForwardTarget {
  id: string;
  name: string;
  avatarSeed: string;
}

/** Подсказка в поле ввода: /clear — очистить историю чата. */
export interface ChatCommand {
  command: string;
  label: string;
}

/** Что умеет конкретный чат. Все методы бросают ошибку с понятным текстом при неудаче. */
export interface ChatBackend {
  /** стабильный ключ чата (для черновиков, загрузок) */
  key: string;
  /** групповой чат: показывать имена отправителей */
  group: boolean;
  /** лимит длины текста */
  maxLength: number;
  /** реакции, которые предлагать в меню */
  quickReactions: string[];

  /** mentions — выбранные в автодополнении участники (только если backend.mentionCandidates есть) */
  sendText(text: string, replyToId?: string | null, mentions?: ChatMentionCandidate[]): Promise<void>;
  editText(id: string, text: string): Promise<void>;
  /** фото уходят как фото, остальное — файлами */
  sendFiles(files: File[], replyToId?: string | null): Promise<void>;
  sendVoice(rec: VoiceRecording, replyToId?: string | null): Promise<void>;
  /** поставить/снять реакцию */
  toggleReaction(id: string, key: string): Promise<void>;
  canEdit(m: ChatMessage): boolean;
  canDelete(m: ChatMessage): boolean;
  /** forAll === null — у собеседника удалить нельзя, спрашивать не надо */
  canDeleteForAll(m: ChatMessage): boolean;
  deleteMessage(id: string, forAll: boolean): Promise<void>;
  forwardTargets(): Promise<ChatForwardTarget[]>;
  forward(id: string, targetId: string): Promise<void>;
  setTyping(on: boolean): void;

  /** blob:/http URL медиа; thumb — по возможности миниатюра */
  mediaUrl(media: ChatMedia, thumb?: boolean): Promise<string>;
  /** фото профиля участника, null — нет */
  avatarUrl(senderId: string): Promise<string | null>;
  /** открыть профиль участника (может отсутствовать) */
  openProfile?(senderId: string): void;

  /* ---- необязательные возможности (есть у Matrix) ---- */
  /** удаление бывает только «у всех» (Matrix): один вариант в диалоге */
  deleteOnlyForAll?: boolean;
  /** ключ черновика в localStorage (по умолчанию 'rl.draft.chat:' + key) */
  draftKey?: string;
  /** повторить / отменить неотправленное */
  resend?(id: string): void;
  cancelSend?(id: string): void;
  /** свой рендер сообщения (карточки ботов); null — обычный пузырь */
  renderCustom?(m: ChatMessage): ReactNode | null;
  /** кандидаты для @упоминаний по началу имени; нет метода — автодополнения нет */
  mentionCandidates?(query: string): ChatMentionCandidate[];
  /** HTML для ссылок-упоминаний в тексте: открыть профиль и т. п. — обработчик клика по .msg-text--html */
  onHtmlClick?(e: MouseEvent): void;
  /** команды для подсказки при вводе (например, /clear) */
  commands?: ChatCommand[];
  /** true — команда обработана (текст отправлять не надо) */
  onCommand?(command: string): boolean | Promise<boolean>;
}

/** Состояние ленты, которое отдаёт backend-специфичный хук. */
export interface ChatTimelineState {
  messages: ChatMessage[] | null;
  error: string | null;
  loadingOlder: boolean;
  atStart: boolean;
  /** true — загрузка началась (иначе уже грузится или история кончилась) */
  loadOlder(): boolean;
  uploads: ChatUpload[];
  /** id первого непрочитанного при открытии (для разделителя «Новые сообщения») */
  firstUnreadId?: string | null;
  /** кто печатает */
  typing: string[];
  /** история очищена: вместо «Начало переписки» показываем «История очищена» */
  cleared?: boolean;
  /** догрузить историю, пока сообщение id не окажется в ленте (поиск); false — не нашли */
  reveal?(id: string): Promise<boolean>;
}
