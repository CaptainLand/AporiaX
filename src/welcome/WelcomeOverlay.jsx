import React, { useCallback, useEffect, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";
import { LanguageSwitch, useI18n } from "../i18n";
import logoUrl from "../../aporiax-logo-clean.png";
import "./welcome.css";

function afterPaint(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

function useWelcomeEffects(imageRef, plateRef, meshRef, metalRef) {
  const [logoStatus, setLogoStatus] = useState("static");
  const [logoImage, setLogoImage] = useState(false);
  const [logoPlate, setLogoPlate] = useState(false);
  const [meshOn, setMeshOn] = useState(false);
  const [metalOn, setMetalOn] = useState(false);
  const cycleRef = useRef({
    index: 0,
    generation: 0,
    logoGen: 0,
    logoDispose: null,
    pending: null,
    assets: null,
    mod: null,
  });

  useEffect(() => {
    const motion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const state = cycleRef.current;
    let extras = [];
    const hideLayers = () => {
      setLogoImage(false);
      setLogoPlate(false);
    };
    const reveal = (kind, outgoing) => {
      if (kind === "masked") setLogoPlate(true);
      else setLogoImage(true);
      setLogoStatus("animated");
      afterPaint(() => {
        if (kind === "masked") setLogoImage(false);
        else setLogoPlate(false);
        afterPaint(() => outgoing?.());
      });
    };
    const clearLogo = () => {
      state.pending?.();
      state.pending = null;
      state.logoDispose?.();
      state.logoDispose = null;
    };
    const clearAll = () => {
      clearLogo();
      for (const dispose of extras) dispose?.();
      extras = [];
    };
    const mountLogo = (index, generation) => {
      const mod = state.mod;
      if (!mod) return;
      const effect = mod.LOGO_CYCLE[index];
      const host = effect.kind === "masked" ? plateRef.current : imageRef.current;
      if (!host) return;
      const logoGen = ++state.logoGen;
      state.pending?.();
      const incoming = mod.mountLogoEffect(host, effect, state.assets, {
        onReady: () => {
          if (generation !== state.generation || logoGen !== state.logoGen) {
            incoming();
            return;
          }
          const outgoing = state.logoDispose;
          state.logoDispose = incoming;
          state.pending = null;
          reveal(effect.kind, outgoing);
        },
        onError: (error) => {
          if (generation !== state.generation || logoGen !== state.logoGen) return;
          if (state.pending === incoming) state.pending = null;
          if (state.logoDispose && state.logoDispose !== incoming) return;
          state.logoDispose = null;
          hideLayers();
          if (index === 0) {
            console.warn("AporiaX welcome: using static logo.", error);
            setLogoStatus("fallback");
          } else {
            setLogoStatus("static");
          }
        },
      });
      state.pending = incoming;
    };
    const update = () => {
      const generation = ++state.generation;
      clearAll();
      state.index = 0;
      state.logoGen = 0;
      setLogoStatus("static");
      hideLayers();
      setMeshOn(false);
      setMetalOn(false);
      if (motion.matches) return;
      void import("./welcome-effects.js").then(async (mod) => {
        if (generation !== state.generation) return;
        state.mod = mod;
        state.assets = await mod.loadLogoCycleAssets();
        if (generation !== state.generation) return;
        mountLogo(0, generation);
        if (meshRef.current) {
          extras.push(mod.mountMeshFlow(meshRef.current, {
            onReady: () => { if (generation === state.generation) setMeshOn(true); },
            onError: () => {},
          }));
        }
        if (metalRef.current) {
          extras.push(mod.mountLiquidMetal(metalRef.current, {
            onReady: () => { if (generation === state.generation) setMetalOn(true); },
            onError: () => {},
          }));
        }
      }).catch((error) => {
        if (generation !== state.generation) return;
        console.warn("AporiaX welcome: animation unavailable.", error);
        setLogoStatus("fallback");
      });
    };
    update();
    motion.addEventListener("change", update);
    return () => {
      state.generation += 1;
      motion.removeEventListener("change", update);
      clearAll();
    };
  }, [imageRef, plateRef, meshRef, metalRef]);

  const cycleLogo = useCallback(() => {
    const state = cycleRef.current;
    if (!state.mod || !state.assets) return;
    state.index = (state.index + 1) % state.mod.LOGO_CYCLE.length;
    const effect = state.mod.LOGO_CYCLE[state.index];
    const host = effect.kind === "masked" ? plateRef.current : imageRef.current;
    if (!host) return;
    const generation = state.generation;
    const logoGen = ++state.logoGen;
    state.pending?.();
    const incoming = state.mod.mountLogoEffect(host, effect, state.assets, {
      onReady: () => {
        if (generation !== state.generation || logoGen !== state.logoGen) {
          incoming();
          return;
        }
        const outgoing = state.logoDispose;
        state.logoDispose = incoming;
        state.pending = null;
        if (effect.kind === "masked") setLogoPlate(true);
        else setLogoImage(true);
        setLogoStatus("animated");
        afterPaint(() => {
          if (effect.kind === "masked") setLogoImage(false);
          else setLogoPlate(false);
          afterPaint(() => outgoing?.());
        });
      },
      onError: () => {
        if (generation !== state.generation || logoGen !== state.logoGen) return;
        if (state.pending === incoming) state.pending = null;
        if (state.logoDispose && state.logoDispose !== incoming) return;
        state.logoDispose = null;
        setLogoImage(false);
        setLogoPlate(false);
        setLogoStatus("static");
      },
    });
    state.pending = incoming;
  }, [imageRef, plateRef]);

  return { logoStatus, logoImage, logoPlate, meshOn, metalOn, cycleLogo };
}

export default function WelcomeOverlay({ onContinue }) {
  const { tr } = useI18n();
  const dialogRef = useRef(null);
  const enterRef = useRef(null);
  const imageRef = useRef(null);
  const plateRef = useRef(null);
  const meshRef = useRef(null);
  const metalRef = useRef(null);
  const { logoStatus, logoImage, logoPlate, meshOn, metalOn, cycleLogo } = useWelcomeEffects(imageRef, plateRef, meshRef, metalRef);

  useEffect(() => {
    const previous = document.activeElement;
    enterRef.current?.focus({ preventScroll: true });
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus({ preventScroll: true }); };
  }, []);

  const keepFocus = (event) => {
    if (event.key !== "Tab") return;
    const controls = [...dialogRef.current.querySelectorAll("button:not(:disabled)")];
    const first = controls[0];
    const last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  };

  const onBackgroundClick = (event) => {
    if (event.target.closest("button, .ax-welcome__enter, .ax-welcome__language")) return;
    cycleLogo();
  };

  return (
    <section className="ax-welcome" ref={dialogRef} role="dialog" aria-modal="true"
      aria-labelledby="ax-welcome-title" aria-describedby="ax-welcome-subtitle"
      onKeyDown={keepFocus} onClick={onBackgroundClick}>
      <div className="ax-welcome__drag" aria-hidden="true" />
      <div className="ax-welcome__mesh" ref={meshRef} data-effect={meshOn ? "animated" : "static"} aria-hidden="true" />
      <div className="ax-welcome__composition">
        <div className="ax-welcome__copy">
          <h1 id="ax-welcome-title">Aporia<span>X</span></h1>
          <p className="ax-welcome__subtitle" id="ax-welcome-subtitle">
            {tr("每个答案，都始于一个尚未解开的疑问。", "Every answer begins with a question yet to be explored.")}
          </p>
          <button className="ax-welcome__enter" ref={enterRef} type="button" data-metal={metalOn ? "animated" : "static"} onClick={onContinue}>
            <span className="ax-welcome__enter-metal" ref={metalRef} aria-hidden="true" />
            <span>{tr("进入 AporiaX", "Enter AporiaX")}</span>
            <ArrowRight size={18} aria-hidden="true" />
          </button>
        </div>
        <div
          className="ax-welcome__art"
          data-effect={logoStatus}
          data-image={logoImage ? "" : undefined}
          data-plate={logoPlate ? "" : undefined}
          aria-hidden="true"
        >
          <div className="ax-welcome__halo" />
          <img className="ax-welcome__original" src={logoUrl} alt="" width="1254" height="1254" draggable="false" />
          <div className="ax-welcome__shader" ref={imageRef} />
          <div className="ax-welcome__plate" ref={plateRef} />
        </div>
      </div>
      <footer className="ax-welcome__footer">
        <LanguageSwitch className="ax-welcome__language" />
      </footer>
    </section>
  );
}
