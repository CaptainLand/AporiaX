import "./prompt-folding.css";

const PROMPT_CHAR_LIMIT = 900;
const PROMPT_LINE_LIMIT = 12;
const PROMPT_HEIGHT_LIMIT = 240;
let queued = false;

function isEnglish() {
  return String(document.documentElement.lang || "")
    .toLowerCase()
    .startsWith("en");
}

function promptNeedsFolding(bubble) {
  const text = String(bubble?.textContent || "");
  if (!text.trim()) return false;
  const lineCount = text.split(/\r?\n/).length;
  return (
    text.length > PROMPT_CHAR_LIMIT ||
    lineCount > PROMPT_LINE_LIMIT ||
    bubble.scrollHeight > PROMPT_HEIGHT_LIMIT
  );
}

function updateToggle(article, button) {
  const expanded = article.classList.contains("prompt-expanded");
  button.setAttribute("aria-expanded", String(expanded));
  button.textContent = expanded
    ? isEnglish()
      ? "Collapse prompt"
      : "收起提示词"
    : isEnglish()
      ? "Expand full prompt"
      : "展开完整提示词";
}

function removeFolding(article) {
  article.classList.remove("prompt-foldable", "prompt-expanded");
  article.querySelector(":scope > .prompt-fold-toggle")?.remove();
}

function syncPrompt(article) {
  const bubble = article.querySelector(":scope > .message-bubble");
  if (!bubble) {
    removeFolding(article);
    return;
  }

  if (!promptNeedsFolding(bubble)) {
    removeFolding(article);
    return;
  }

  article.classList.add("prompt-foldable");
  let button = article.querySelector(":scope > .prompt-fold-toggle");
  if (!button) {
    button = document.createElement("button");
    button.type = "button";
    button.className = "prompt-fold-toggle";
    button.addEventListener("click", () => {
      article.classList.toggle("prompt-expanded");
      updateToggle(article, button);
    });
    const attachments = article.querySelector(":scope > .user-attachments");
    if (attachments) {
      article.insertBefore(button, attachments);
    } else {
      bubble.insertAdjacentElement("afterend", button);
    }
  }
  updateToggle(article, button);
}

function syncAllPrompts() {
  for (const article of document.querySelectorAll(
    ".message-list .user-message",
  )) {
    syncPrompt(article);
  }
}

function scheduleSync() {
  if (queued) return;
  queued = true;
  window.requestAnimationFrame(() => {
    queued = false;
    syncAllPrompts();
  });
}

const observer = new MutationObserver(scheduleSync);
observer.observe(document.documentElement, {
  childList: true,
  subtree: true,
  characterData: true,
});

window.addEventListener("resize", scheduleSync);
window.addEventListener("languagechange", scheduleSync);

scheduleSync();
