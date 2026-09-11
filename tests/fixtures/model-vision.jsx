import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { I18nProvider } from "../../src/i18n.jsx";
import { ModelVisionSettings } from "../../src/settings/ModelVisionSettings.jsx";
import { TaskCapabilityCards } from "../../src/settings/TaskCapabilityCards.jsx";
import { providerModelsById, buildProviderModels } from "../../src/state/provider-models.js";
import "../../src/styles.css";
const params = new URLSearchParams(location.search);
localStorage.setItem("aporiax.language.v1",params.get("lang") || "zh-CN");
document.documentElement.dataset.theme=params.get("theme") || "light";
function Fixture() {
  const [providers,setProviders]=useState([]);
  const [models,setModels]=useState({});
  const [saved,setSaved]=useState(false);
  const receive=(records)=>{setProviders(records);setModels(providerModelsById(records[0].models));};
  useEffect(()=>{fetch('/__vision_provider').then(r=>r.json()).then(receive);},[]);
  const save=async()=>{const response=await fetch('/__vision_provider',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({models:buildProviderModels(Object.keys(models),models)})});receive(await response.json());setSaved(true);};
  return <main style={{width:304,maxWidth:'100%',height:'100vh',overflow:'auto',padding:12}}>
    <ModelVisionSettings modelIds={Object.keys(models)} modelsById={models} onChange={value=>{setModels(value);setSaved(false);}} />
    <button onClick={save}>Save configuration</button>{saved&&<output>Saved</output>}
    <TaskCapabilityCards task={{providerId:'ds',modelId:'deepseek-v4.1-flash'}} providers={providers} onManageProviders={()=>{}} />
  </main>;
}
createRoot(document.getElementById('root')).render(<I18nProvider><Fixture /></I18nProvider>);
