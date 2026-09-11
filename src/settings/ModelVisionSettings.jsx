import React from "react";
import { useI18n } from "../i18n.jsx";
import "./model-vision-settings.css";

export function ModelVisionSettings({ modelIds, modelsById = {}, onChange }) {
  const { tr } = useI18n();
  if (!modelIds.length) return null;
  return <fieldset className="model-vision-settings">
    <legend>{tr("图片输入能力", "Image input capability")}</legend>
    <p>{tr("默认按原生视觉发送图片。若模型实际无法看图，会自动改为仅文本。设置不会发起付费测试。", "Native vision is the default. If the model cannot read images, it switches to text only. This does not run a paid test.")}</p>
    {[...new Set(modelIds)].map((id) => <label className="model-vision-row" key={id}>
      <span title={id}>{id}</span>
      <select aria-label={tr("{id} 图片输入", "{id} image input", { id })} value={modelsById[id]?.imageInput === "text" ? "text" : "native"}
        onChange={(event) => onChange({ ...modelsById, [id]: { ...modelsById[id], id, imageInput: event.target.value } })}>
        <option value="native">{tr("原生视觉", "Native vision")}</option>
        <option value="text">{tr("仅文本", "Text only")}</option>
      </select>
    </label>)}
  </fieldset>;
}
