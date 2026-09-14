export const BLOB_SCHEME = "aporiax-blob";
export const COMPOSER_ATTACHMENT_DRAG = "application/x-aporiax-composer-attachment";
export const COMPOSER_ATTACHMENT_DRAGGING_CLASS = "composer-attachment-dragging";

let activeComposerDrag = null;

function setComposerAttachmentDragging(active) {
  if (typeof document === "undefined") return;
  document.documentElement.classList.toggle(COMPOSER_ATTACHMENT_DRAGGING_CLASS, active);
}

export function attachmentImageSrc(attachment) {
  if (attachment?.dataUrl) return attachment.dataUrl;
  if (attachment?.hash) return `${BLOB_SCHEME}://${attachment.hash}`;
  return "";
}

export function filePathOf(file) {
  const path = typeof file?.path === "string" ? file.path.trim() : "";
  return path || "";
}

export function isComposerAttachmentDrag(dataTransfer) {
  return [...(dataTransfer?.types || [])].includes(COMPOSER_ATTACHMENT_DRAG);
}

export function beginComposerAttachmentDrag(event, attachment) {
  activeComposerDrag = attachment || null;
  event.dataTransfer.effectAllowed = "copy";
  event.dataTransfer.setData(COMPOSER_ATTACHMENT_DRAG, attachment?.id || "1");
  event.dataTransfer.setData("text/plain", attachment?.name || "");
  setComposerAttachmentDragging(true);
}

export function endComposerAttachmentDrag() {
  activeComposerDrag = null;
  setComposerAttachmentDragging(false);
}

export function composerAttachmentFromDataTransfer(dataTransfer) {
  if (!isComposerAttachmentDrag(dataTransfer)) return null;
  return activeComposerDrag;
}

export function presentComposerAttachment(workbench, attachment, onNotice, tr = (zh) => zh) {
  if (!workbench || !attachment) return false;
  workbench.expand?.();
  if (attachment.kind !== "document") {
    const src = attachmentImageSrc(attachment);
    if (src) {
      workbench.openImage(src, attachment.name || "图片");
      return true;
    }
  }
  if (attachment.path) {
    workbench.openFile(attachment.path);
    return true;
  }
  onNotice?.(tr("该附件没有本地路径，无法在侧栏打开预览", "This attachment has no local path to preview in the sidebar"));
  return false;
}
