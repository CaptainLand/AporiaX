const JOURNAL_SELECTOR = ".assistant-progress-journal";
const RUNNING_SELECTOR = ".aporiax-run-duration.running";
const EXPANDED_CLASS = "manual-expanded";

function completedJournalFromTarget(target) {
  if (!(target instanceof Element)) return null;
  const journal = target.closest(JOURNAL_SELECTOR);
  if (!journal) return null;
  const assistant = journal.closest(".assistant-message");
  if (!assistant || assistant.querySelector(RUNNING_SELECTOR)) return null;
  return journal;
}

function toggleJournal(journal) {
  const expanded = journal.classList.toggle(EXPANDED_CLASS);
  journal.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function isInteractiveDescendant(target, journal) {
  if (!(target instanceof Element)) return false;
  const interactive = target.closest("a, button, input, textarea, select, summary, [role='button']");
  return Boolean(interactive && interactive !== journal && journal.contains(interactive));
}

document.addEventListener("click", (event) => {
  const journal = completedJournalFromTarget(event.target);
  if (!journal || isInteractiveDescendant(event.target, journal)) return;
  toggleJournal(journal);
});

document.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const journal = completedJournalFromTarget(event.target);
  if (!journal || event.target !== journal) return;
  event.preventDefault();
  toggleJournal(journal);
});

document.addEventListener("focusin", (event) => {
  const journal = completedJournalFromTarget(event.target);
  if (!journal) return;
  if (!journal.hasAttribute("tabindex")) journal.setAttribute("tabindex", "0");
  if (!journal.hasAttribute("role")) journal.setAttribute("role", "button");
  if (!journal.hasAttribute("aria-expanded")) journal.setAttribute("aria-expanded", "false");
});

document.addEventListener("pointerover", (event) => {
  const journal = completedJournalFromTarget(event.target);
  if (!journal) return;
  if (!journal.hasAttribute("tabindex")) journal.setAttribute("tabindex", "0");
  if (!journal.hasAttribute("role")) journal.setAttribute("role", "button");
  if (!journal.hasAttribute("aria-expanded")) journal.setAttribute("aria-expanded", "false");
}, { passive: true });
