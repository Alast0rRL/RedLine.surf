/**
 * Тонкие React-обёртки над классами @redline/ui. Вся визуальная часть — в
 * packages/redline-ui (components.css), здесь только разметка и поведение.
 */
import {
  forwardRef,
  useEffect,
  useId,
  useRef,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { avatarColor, closeModal, initials, openModal } from '@redline/ui';
import { focusForInput } from '../lib/modality';
import type { MatrixClient } from 'matrix-js-sdk';
import { useMediaUrl } from '../hooks/useMediaUrl';

export { toast } from '@redline/ui';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

/* ---------------- Button ---------------- */
type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'outline' | 'danger' | 'default';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  icon?: boolean;
  round?: boolean;
  block?: boolean;
  busy?: boolean;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'default', size = 'md', icon, round, block, busy, className, type = 'button', ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-busy={busy || undefined}
      className={cx(
        'rl-btn',
        variant === 'danger' ? 'rl-btn--secondary rl-btn--danger' : variant !== 'default' && `rl-btn--${variant}`,
        size !== 'md' && `rl-btn--${size}`,
        icon && 'rl-btn--icon',
        round && 'rl-btn--round',
        block && 'rl-btn--block',
        className,
      )}
      {...rest}
    />
  );
});

/* ---------------- Input ---------------- */
type FieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string;
  labelHint?: string;
  suffix?: ReactNode;
  error?: string | null;
};

export const Field = forwardRef<HTMLInputElement, FieldProps>(function Field({ label, hint, labelHint, suffix, error, className, ...rest }, ref) {
  const id = useId();
  const hintId = `${id}-hint`;
  const labelHintId = `${id}-label-hint`;
  const describedBy = [labelHint && labelHintId, (hint || error) && hintId].filter(Boolean).join(' ') || undefined;
  const input = (
    <input
      ref={ref}
      id={id}
      className="rl-input"
      aria-invalid={error ? true : undefined}
      aria-describedby={describedBy}
      {...rest}
    />
  );
  return (
    <label className={cx('rl-field', className)} htmlFor={id}>
      <span className="rl-field__label-row">
        <span className="rl-label">{label}</span>
        {labelHint && <span id={labelHintId} className="rl-label-hint">{labelHint}</span>}
      </span>
      {suffix ? (
        <span className="rl-input-affix">
          {input}
          <span className="rl-input-affix__suffix">{suffix}</span>
        </span>
      ) : input}
      {(error || hint) && (
        <span id={hintId} className={cx('rl-hint', error && 'rl-hint--error')}>
          {error || hint}
        </span>
      )}
    </label>
  );
});

/* ---------------- Card ---------------- */
export function Card({ children, className, solid, large }: { children: ReactNode; className?: string; solid?: boolean; large?: boolean }) {
  return <div className={cx('rl-card', solid && 'rl-card--solid', large && 'rl-card--lg', className)}>{children}</div>;
}

/* ---------------- Avatar ---------------- */
type AvatarSize = 'xs' | 'sm' | 'md' | 'lg' | 'xl';
const AVATAR_PX: Record<AvatarSize, number> = { xs: 24, sm: 32, md: 40, lg: 56, xl: 128 };

export function Avatar({
  client,
  name,
  seed,
  mxc,
  size = 'md',
  round,
  status,
}: {
  client?: MatrixClient;
  name: string;
  /** стабильный ключ цвета (userId / roomId) */
  seed: string;
  mxc?: string | null;
  size?: AvatarSize;
  round?: boolean;
  status?: 'online';
}) {
  const px = AVATAR_PX[size] * 2; // ретина
  const url = useMediaUrl(client && mxc ? { url: mxc } : null, { width: px, height: px });
  return (
    <span
      className={cx('rl-avatar', size !== 'md' && `rl-avatar--${size}`, round && 'rl-avatar--round')}
      data-color={avatarColor(seed)}
      aria-hidden="true"
    >
      {url && url !== 'error' ? <img src={url} alt="" draggable={false} /> : initials(name)}
      {status && <span className="rl-avatar__status" data-status={status} />}
    </span>
  );
}

/* ---------------- Modal ---------------- */
export function Modal({
  open,
  onClose,
  title,
  children,
  actions,
  className,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      openModal(d);
      focusForInput(d.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'), d);
    }
    if (!open && d.open) void closeModal(d);
  }, [open]);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    const onDialogClose = () => onClose();
    d.addEventListener('close', onDialogClose);
    return () => d.removeEventListener('close', onDialogClose);
  }, [onClose]);

  return (
    <dialog ref={ref} className={cx('rl-modal', className)} aria-labelledby={titleId}>
      <Button variant="ghost" size="sm" icon className="rl-modal__close" aria-label="Закрыть" data-rl-close>
        <Icon name="close" />
      </Button>
      <h2 className="rl-modal__title" id={titleId}>{title}</h2>
      <div className="rl-modal__body">{open ? children : null}</div>
      {actions && <div className="rl-modal__actions">{actions}</div>}
    </dialog>
  );
}

/* ---------------- Icons ---------------- */
const ICONS = {
  back: 'M15 19l-7-7 7-7',
  close: 'M6 18L18 6M6 6l12 12',
  send: 'M5 12h14M13 6l6 6-6 6',
  mic: 'M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3zM5 10a7 7 0 0 0 14 0M12 17v5',
  image: 'M4 5h16v14H4zM4 15l4-4 4 4 3-3 5 5M15 9.5a1.5 1.5 0 1 0 0-.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  plus: 'M12 5v14M5 12h14',
  play: 'M7 4v16l13-8z',
  pause: 'M7 4h4v16H7zM13 4h4v16h-4z',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  check: 'M5 12l5 5L20 7',
  checks: 'M1 12.5l4.5 4.5L15 7.5M9.5 16.5l.5.5L22 7',
  clock: 'M12 7v5l3 2M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  alert: 'M12 8v5M12 16.5v.01M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z',
  trash: 'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  chevronUp: 'M6 15l6-6 6 6',
  logout: 'M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4M10 17l5-5-5-5M15 12H3',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  bot: 'M12 8V4M8 4h8M5 8h14v11H5zM9 13v1M15 13v1M2 12v3M22 12v3',
  key: 'M15 7a4 4 0 1 1-3.9 5H3v3h3v3h3v-3h2.1A4 4 0 0 1 15 7zM16 10v.01',
  copy: 'M9 9h11v11H9zM5 15H4V4h11v1',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ name, size = 20, strokeWidth = 2 }: { name: IconName; size?: number; strokeWidth?: number }) {
  const filled = name === 'play' || name === 'pause';
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={ICONS[name]} />
    </svg>
  );
}

/* ---------------- Red lines ---------------- */
type RedLinesProps = { lines?: number; speed?: number; brightness?: number; noIntro?: boolean; className?: string };

export function RedLines({ lines, speed, brightness, noIntro, className }: RedLinesProps) {
  return (
    <rl-red-lines
      class={className}
      lines={lines}
      speed={speed}
      brightness={brightness}
      no-intro={noIntro ? '' : undefined}
    />
  );
}

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'rl-red-lines': {
        class?: string;
        lines?: number;
        speed?: number;
        brightness?: number;
        'no-intro'?: string;
        disabled?: boolean;
      };
    }
  }
}
