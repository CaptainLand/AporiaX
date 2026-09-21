import { FileText, PanelRightOpen } from "lucide-react";
import { useI18n } from "../i18n";
import { FilePane } from "./WorkbenchPanes.jsx";
import "./workspace-preview.css";

// Main workspace browsing shares the sidebar's renderers but does not own an
// editor draft. Edits stay in a dedicated sidebar tab, so refreshing the main
// preview cannot overwrite a draft or clear that tab's unsaved-change guard.
export function WorkspaceFilePreview({ path, revision, task, workbench, onNotice }) {
  const { tr } = useI18n();
  if (!path) return <div className="workspace-preview-empty"><FileText size={22} />{tr("选择文件以阅读，编辑可在侧栏打开", "Select a file to read; open it in the sidebar to edit")}</div>;
  const tab = { id: `workspace-preview:${path}`, kind: "file", title: path.split(/[/\\]/).at(-1), path, revision };
  return <div className="workspace-rich-preview">
    <div className="workspace-inline-toolbar">
      <FileText size={15} /><span title={path}>{path}</span>
      <button type="button" aria-label={tr("在侧栏打开或编辑", "Open or edit in sidebar")} title={tr("在侧栏打开或编辑", "Open or edit in sidebar")} onClick={() => workbench.openFile(path)}><PanelRightOpen size={15} /><span>{tr("在侧栏打开", "Open in sidebar")}</span></button>
    </div>
    <div className="workspace-inline-content"><FilePane key={`${workbench.key}:${path}`} tab={tab} task={task} workbench={workbench} onNotice={onNotice} previewOnly /></div>
  </div>;
}
