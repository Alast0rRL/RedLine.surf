/** Иконки, которых нет в ui.tsx: закрепление, «без звука», пользователь, правка. */
const PATHS = {
  pin: 'M12 17v5M9 3h6l-1 6 3 3v2H7v-2l3-3z',
  bellOff: 'M18 8a6 6 0 0 0-9.3-5M6.3 6.3A6 6 0 0 0 6 8c0 7-3 9-3 9h13M13.7 21a2 2 0 0 1-3.4 0M3 3l18 18',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
} as const;

export function ExtraIcon({ name, size = 18 }: { name: keyof typeof PATHS; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
