import { useEffect, useId, useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { useI18n } from "../i18n";
import { ModelMenu } from "../models/ModelMenu.jsx";

export function sideChatModelLabel(model = {}) {
  const label = model.shortName || model.name || model.modelId || model.id || "";
  // Keep the exact API ID in the tooltip; dated access suffixes aren't a useful label.
  return label.replace(/[-_]expires[-_]on[-_]\d+$/i, "");
}

export function SideChatModelPicker({ providers, options, choice, disabled, onSelect, onManageProviders }) {
  const { tr } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null), triggerRef = useRef(null);
  const popupId = useId();
  const close = (restoreFocus = false) => { setOpen(false); if (restoreFocus) triggerRef.current?.focus(); };
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);
  const ModelIcon = choice?.icon;
  return <div className="side-chat-model-picker" ref={rootRef}>
    <button ref={triggerRef} className={"model-trigger side-chat-model-trigger" + (open ? " active" : "")} type="button" aria-label={tr("侧聊模型", "Side chat model")} aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? popupId : undefined} disabled={disabled}
      title={choice ? choice.providerName + " · " + choice.modelId + "\n" + tr("仅更改侧聊模型；提问使用此模型的额度", "Only changes the side-chat model; questions use its quota") : tr("请先配置模型", "Configure a model first")}
      onClick={() => setOpen((value) => !value)} onKeyDown={(event) => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); setOpen(true); } }}>
      {ModelIcon && <ModelIcon size={15} />}<span>{choice && !choice.disabled ? sideChatModelLabel(choice) : tr("选择模型", "Choose a model")}</span><ChevronDown size={13} />
    </button>
    {open && <ModelMenu providers={providers} task={{ providerId: choice?.providerId || '', modelId: choice?.modelId || '' }}
      id={popupId} className="side-chat-model-menu" optionsRole showReasoning={false} boundaryRef={rootRef}
      label={tr("选择侧聊模型", "Choose a side-chat model")} onClose={close}
      onUpdate={selection => {
        const option = options.find(item => item.providerId === selection.providerId && item.modelId === selection.modelId);
        if (!option || option.disabled) return;
        onSelect(option.value); close(true);
      }} onManageProviders={onManageProviders ? () => { close(); onManageProviders(); } : undefined} />}
  </div>;
}
