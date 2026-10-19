import { memo, useEffect, useRef, useState } from 'react';

// The same Paper Gem Smoke effect as the website quota bar. A CSS gradient
// remains visible when motion is reduced or WebGL is unavailable.
export const EffortGem = memo(function EffortGem({ speed = 1 }) {
  const host = useRef(null);
  const speedRef = useRef(speed);
  speedRef.current = speed;
  const [motion, setMotion] = useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [state, setState] = useState('static');
  useEffect(() => {
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const update = () => setMotion(!media.matches);
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, []);
  useEffect(() => {
    if (!motion) { setState('static'); return; }
    let cancelled = false;
    let dispose;
    setState('loading');
    const fail = () => { if (!cancelled) setState('fallback'); };
    void import('./effort-gem-renderer.js').then(({ mountEffortGem }) => {
      if (cancelled || !host.current) return;
      dispose = mountEffortGem(host.current, {
        getSpeed: () => speedRef.current,
        onReady: () => { if (!cancelled) setState('animated'); }, onError: fail,
      });
    }).catch(fail);
    return () => { cancelled = true; dispose?.(); };
  }, [motion]);
  return <span ref={host} className="effort-gem" data-state={state} data-speed={motion ? speed : 0} aria-hidden="true" />;
});
