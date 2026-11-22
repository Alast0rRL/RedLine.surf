import { RedLines } from '../components/ui';

export function Splash({ text, error }: { text?: string; error?: string | null }) {
  return (
    <main className="screen splash" aria-busy={!error}>
      <RedLines />
      <div className="splash__content">
        <div className="splash__logo">Redline</div>
        {error ? (
          <p className="splash__error" role="alert">{error}</p>
        ) : (
          <>
            <span className="rl-spinner" />
            {text && <p className="splash__text">{text}</p>}
          </>
        )}
      </div>
    </main>
  );
}
