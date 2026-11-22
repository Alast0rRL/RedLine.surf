import type { ComponentType } from 'react';
import type { MatrixEvent } from 'matrix-js-sdk';
import { getConfig } from '../config';

/**
 * Точка расширения для ботов (Мари и будущие).
 *
 * Бот — обычный пользователь Matrix. Клиент узнаёт его по списку `botUsers`
 * из config.json и рисует его сообщения карточкой: m.notice и форматированный
 * HTML (org.matrix.custom.html) поддерживаются из коробки.
 *
 * Когда боту понадобится что-то богаче текста (прогресс воды, кнопки напоминаний),
 * он шлёт событие с дополнительным полем в content, а здесь регистрируется
 * отрисовщик:
 *
 *   registerMessageRenderer({
 *     id: 'mari-water',
 *     match: (ev) => ev.getContent()['surf.redline.mari.water'] !== undefined,
 *     component: WaterCard,
 *   });
 *
 * Другие клиенты (Element) при этом увидят обычный текст из body.
 */

export interface MessageRendererProps {
  event: MatrixEvent;
}

export interface MessageRenderer {
  id: string;
  match: (ev: MatrixEvent) => boolean;
  component: ComponentType<MessageRendererProps>;
}

const renderers: MessageRenderer[] = [];

export function registerMessageRenderer(r: MessageRenderer): void {
  if (!renderers.some((x) => x.id === r.id)) renderers.push(r);
}

export function findRenderer(ev: MatrixEvent): MessageRenderer | undefined {
  return renderers.find((r) => r.match(ev));
}

export function isBotUser(userId: string | undefined): boolean {
  return !!userId && getConfig().botUsers.includes(userId);
}

/** Сообщение показываем в стиле бота: от бота или любое m.notice (так помечают автоответы). */
export function isBotStyled(ev: MatrixEvent): boolean {
  return isBotUser(ev.getSender()) || ev.getContent().msgtype === 'm.notice';
}
