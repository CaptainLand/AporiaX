import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useI18n } from "../i18n";
import { ModelSetupActions } from "../models/ModelSetupActions.jsx";

export function sideChatModelLabel(model = {}) {
  const label = model.shortName || model.name || model.modelId || model.id || "";
  // Keep the exact API ID in the tooltip; dated access suffixes aren't a useful label.
  return label.replace(/[-_]expires[-_]on[-_]\d+$/i, "");
}

export function SideChatModelPicker({ options, choice, disabled, onSelect, onManageProviders }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [height, setHeight] = useState(380);
  const rootRef = useRef(null), triggerRef = useRef(null), searchRef = useRef(null);
  const popupId = useId();
  const filtered = useMemo(() => {
    const value = query.trim().toLocaleLowerCase();
    return options.filter((o) => [o.name, o.shortName, o.modelId, o.providerName].join(" ").toLocaleLowerCase().includes(value));
  }, [options, query]);
  const groups = useMemo(() => [...new Set(filtered.map((o) => o.providerId))].map((id) => ({ id, name: filtered.find((o) => o.providerId === id).providerName, options: filtered.filter((o) => o.providerId === id) })), [filtered]);
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
    const outside = (event) => { if (!rootRef.current?.contains(event.target)) close(); };
    const resize = () => {
      const form = rootRef.current?.closest("form"), pane = rootRef.current?.closest(".side-chat");
      if (form && pane) setHeight(Math.max(80, Math.min(380, form.getBoundingClientRect().top - pane.getBoundingClientRect().top - 12)));
    };
    const observer = new ResizeObserver(resize);
    if (rootRef.current) observer.observe(rootRef.current.closest(".side-chat"));
    resize();
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    return () => { observer.disconnect(); document.removeEventListener("pointerdown", outside); document.removeEventListener("focusin", outside); };
  }, [open]);
  const choose = (option) => { if (!option || option.disabled) return; onSelect(option.value); close(true); };
  const navigate = (event) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (event.nativeEvent.isComposing) return;
    const rows = [...rootRef.current.querySelectorAll('[role="option"]:not(:disabled)')];
    const index = rows.indexOf(document.activeElement);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = index < 0 ? (event.key === "ArrowDown" ? 0 : rows.length - 1) : (index + (event.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length;
      rows[next]?.focus();
    } else if (event.key === "Enter" && event.target === searchRef.current) {
      event.preventDefault(); choose(filtered.find((option) => !option.disabled));
    }
  };
  const ModelIcon = choice?.icon;
  return <div className="side-chat-model-picker" ref={rootRef}>
    <button ref={triggerRef} className={"model-trigger side-chat-model-trigger" + (open ? " active" : "")} type="button" aria-label={tr("侧聊模型", "Side chat model")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined} disabled={disabled}
      title={choice ? choice.providerName + " · " + choice.modelId + "\n" + tr("仅更改侧聊模型；提问使用此模型的额度", "Only changes the side-chat model; questions use its quota") : tr("请先配置模型", "Configure a model first")}
      onClick={() => { setQuery(""); setOpen((value) => !value); }} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setQuery(""); setOpen(true); } }}>
      {ModelIcon && <ModelIcon size={15} />}<span>{choice && !choice.disabled ? sideChatModelLabel(choice) : tr("选择模型", "Choose a model")}</span><ChevronDown size={13} />
    </button>
    {open && <div className="side-chat-model-menu" id={popupId} role="dialog" aria-label={tr("选择侧聊模型", "Choose a side-chat model")} style={{ maxHeight: height }} onKeyDown={navigate}>
      <div className="side-chat-model-search"><Search size={15} /><input ref={searchRef} aria-label={tr("搜索模型", "Search models")} placeholder={tr("搜索模型或 Provider…", "Search models or providers…")} value={query} onChange={(event) => setQuery(event.target.value)} /><button type="button" className="side-chat-icon" aria-label={tr("关闭模型选择", "Close model picker")} onClick={() => close(true)}><X size={15} /></button></div>
      <div className="side-chat-model-options" role="listbox" aria-label={tr("可用模型", "Available models")}>
        {groups.map((group) => <div role="group" aria-label={group.name} key={group.id}>
          <div className="side-chat-model-group">{group.name}</div>
          {group.options.map((option) => { const Icon = option.icon; const selected = choice?.value === option.value;
            return <button type="button" role="option" disabled={Boolean(option.disabled)} aria-selected={selected && !option.disabled} key={option.value} className={"side-chat-model-option" + (selected && !option.disabled ? " selected" : "")} title={option.providerName + " · " + option.modelId} onClick={() => choose(option)}>
              <Icon size={16} /><span><strong>{sideChatModelLabel(option)}</strong><small>{option.disabled ? tr(option.disabledReasonZh || "模型不可用", option.disabledReasonEn || "Model unavailable") : option.modelId}</small></span>{selected && !option.disabled && <Check size={15} />}
            </button>;
          })}
        </div>)}
        {!filtered.length && <p className="side-chat-model-empty">{tr("没有匹配的模型", "No matching models")}</p>}
      </div>
      <ModelSetupActions onManageProviders={onManageProviders ? () => { close(); onManageProviders(); } : undefined} />
    </div>}
  </div>;
}
