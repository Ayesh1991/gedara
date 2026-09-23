import { cn } from '@/lib/utils';

/** Fixed aurora light behind every screen: three drifting blobs in the theme colours + a faint grid. */
export function AuroraBackground({ className }: { className?: string }) {
  return (
    <div aria-hidden className={cn('pointer-events-none fixed inset-0 z-0 overflow-hidden', className)}>
      <div
        className="aurora-blob"
        style={{
          left: '-12vw',
          top: '-22vh',
          width: 'max(46vw, 360px)',
          height: 'max(46vw, 360px)',
          background: 'var(--aur-1)',
          opacity: 'calc(0.5 * var(--aur-strength))',
        }}
      />
      <div
        className="aurora-blob b2"
        style={{
          right: '-14vw',
          top: '-8vh',
          width: 'max(40vw, 300px)',
          height: 'max(40vw, 300px)',
          background: 'var(--aur-2)',
          opacity: 'calc(0.42 * var(--aur-strength))',
        }}
      />
      <div
        className="aurora-blob"
        style={{
          left: '32vw',
          bottom: '-34vh',
          width: 'max(50vw, 380px)',
          height: 'max(40vw, 320px)',
          background: 'var(--aur-3)',
          opacity: 'calc(0.36 * var(--aur-strength))',
        }}
      />
      <div
        className="absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.035) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.035) 1px, transparent 1px)',
          backgroundSize: '48px 48px',
          maskImage: 'radial-gradient(ellipse at 55% 12%, #000 12%, transparent 62%)',
          WebkitMaskImage: 'radial-gradient(ellipse at 55% 12%, #000 12%, transparent 62%)',
        }}
      />
    </div>
  );
}
