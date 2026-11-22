import { Button } from './ui';
import { toggleTheme, useTheme } from '../lib/theme';

export function ThemeToggle({ className }: { className?: string }) {
  const theme = useTheme();
  const label = theme === 'dark' ? 'Светлая тема' : 'Тёмная тема';
  return (
    <Button
      icon
      className={className ? `theme-toggle ${className}` : 'theme-toggle'}
      aria-label={label}
      title={label}
      onClick={toggleTheme}
    >
      {theme === 'dark' ? (
        <svg className="theme-toggle__sun" aria-hidden="true" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364-6.364l-.707.707M6.343 17.657l-.707.707m12.728 0l-.707-.707M6.343 6.343l-.707-.707M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
        </svg>
      ) : (
        <svg className="theme-toggle__moon" aria-hidden="true" width="20" height="20" fill="currentColor" viewBox="0 0 20 20">
          <path d="M17.293 13.293A8 8 0 016.707 2.707a8.001 8.001 0 1010.586 10.586z" />
        </svg>
      )}
    </Button>
  );
}
