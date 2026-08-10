import React from "react";
import { Check } from "lucide-react";
import { useI18n } from "../i18n";

export function IconButton({ label, className = "", children, ...props }) {
  return (
    <button
      className={`icon-button ${className}`.trim()}
      aria-label={label}
      title={label}
      {...props}
    >
      {children}
    </button>
  );
}

export function ModelChoice({ model, selected, onSelect, compact = false }) {
  const { tr } = useI18n();
  const ModelIcon = model.icon;

  return (
    <button
      className={`model-choice ${selected ? "selected" : ""} ${compact ? "compact" : ""}`}
      onClick={() => onSelect(model)}
      type="button"
    >
      <span className="model-choice-icon">
        <ModelIcon size={17} />
      </span>
      <span className="model-choice-copy">
        <span className="model-choice-name">{model.name}</span>
        {!compact && <code className="model-choice-id">{model.id}</code>}
        <small>{tr(model.descriptionZh || model.description, model.descriptionEn || model.description)}</small>
      </span>
      {selected && <Check size={17} className="model-choice-check" />}
    </button>
  );
}

export function Switch({ checked, onChange, label, disabled = false }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      className={`switch ${checked ? "on" : ""}`}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

export function SegmentedControl({ value, onChange, options, ariaLabel }) {
  return (
    <div className="segmented-control" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          className={value === option.value ? "active" : ""}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

