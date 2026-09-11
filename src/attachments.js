export const BLOB_SCHEME = "aporiax-blob";

export function attachmentImageSrc(attachment) {
  if (attachment?.dataUrl) return attachment.dataUrl;
  if (attachment?.hash) return `${BLOB_SCHEME}://${attachment.hash}`;
  return "";
}
