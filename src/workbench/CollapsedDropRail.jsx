import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n";
import {
  composerAttachmentFromDataTransfer,
  isComposerAttachmentDrag,
  presentComposerAttachment,
} from "../attachments.js";
import { isCollapsedDropEdge } from "./drop-edge.js";
import "./workbench.css";

export function CollapsedDropRail({ workbench, onNotice }) {
  const { tr } = useI18n();
  const railRef = useRef(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const root = railRef.current?.closest(".task-workspace");
    if (!root) return undefined;
    const onDragOver = (event) => {
      if (!isComposerAttachmentDrag(event.dataTransfer) || !isCollapsedDropEdge(event, root)) {
        setReady(false);
        return;
      }
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      setReady(true);
    };
    const onDragLeave = (event) => {
      if (!root.contains(event.relatedTarget)) setReady(false);
    };
    const onDrop = (event) => {
      setReady(false);
      if (!isComposerAttachmentDrag(event.dataTransfer) || !isCollapsedDropEdge(event, root)) {
        return;
      }
      const attachment = composerAttachmentFromDataTransfer(event.dataTransfer);
      if (!attachment) return;
      event.preventDefault();
      event.stopPropagation();
      presentComposerAttachment(workbench, attachment, onNotice, tr);
    };
    root.addEventListener("dragover", onDragOver);
    root.addEventListener("dragleave", onDragLeave);
    root.addEventListener("drop", onDrop);
    return () => {
      root.removeEventListener("dragover", onDragOver);
      root.removeEventListener("dragleave", onDragLeave);
      root.removeEventListener("drop", onDrop);
    };
  }, [workbench, onNotice, tr]);

  return (
    <div
      ref={railRef}
      className={`workbench-collapsed-drop${ready ? " workbench-drop-ready" : ""}`}
      aria-hidden="true"
    />
  );
}
