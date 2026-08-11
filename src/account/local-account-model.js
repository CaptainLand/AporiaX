export const APORIAX_DEMO_ACCOUNT = Object.freeze({
  username: "landx",
  password: "111111",
  displayName: "Landx",
});

export const LOCAL_ACCOUNT_SESSION_KEY = "aporiax.local-account-ui.v1";

export function authenticateDemoAccount(username, password) {
  return (
    String(username || "").trim().toLowerCase() === APORIAX_DEMO_ACCOUNT.username &&
    String(password || "") === APORIAX_DEMO_ACCOUNT.password
  );
}

export function validateLocalRegistration({ username, password, confirmPassword }) {
  const normalizedUsername = String(username || "").trim();
  if (!/^[A-Za-z0-9_-]{3,24}$/u.test(normalizedUsername)) return "username";
  if (String(password || "").length < 6) return "password";
  if (password !== confirmPassword) return "confirm";
  return "";
}

export function createLocalAccountProfile({ username, displayName = "" }) {
  const normalizedUsername = String(username || "").trim();
  return {
    username: normalizedUsername,
    displayName: String(displayName || "").trim() || normalizedUsername,
    localPrototype: true,
    signedInAt: new Date().toISOString(),
  };
}
