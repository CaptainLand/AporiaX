import { createContext, useContext, useEffect, useRef, useState } from "react";

const AccountContext = createContext(null);
const unavailable = { account: { status: "unavailable" }, busy: false, error: "", api: null, setAccount: () => {}, setError: () => {}, signIn: async () => null, refresh: async () => null, signOut: async () => null };

// One account snapshot for the footer and all model pickers. Never expose tokens.
export function AccountProvider({ children }) {
  const api = window.desktop?.account;
  const [account, setAccount] = useState({ status: "booting" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0), pending = useRef(false);
  useEffect(() => {
    let active = true;
    const expected = ++revision.current;
    if (!api?.get) { setAccount({ status: "unavailable" }); return; }
    Promise.resolve().then(() => api.get()).then((snapshot) => {
      if (!active || revision.current !== expected) return;
      setAccount(snapshot || { status: "anonymous" }); setError(snapshot?.error || "");
    }).catch((failure) => {
      if (!active || revision.current !== expected) return;
      setAccount({ status: "error" }); setError(failure.message || "APORIAX_ACCOUNT_LOAD_FAILED");
    });
    return () => { active = false; };
  }, [api]);
  const perform = async (method) => {
    if (pending.current || account.status === "booting" || typeof api?.[method] !== "function") return null;
    pending.current = true; setBusy(true); setError("");
    const expected = ++revision.current;
    try {
      const snapshot = await api[method]();
      if (revision.current === expected && !snapshot?.canceled) {
        setAccount(snapshot || { status: "anonymous" }); setError(snapshot?.error || "");
      }
      return snapshot;
    } catch (failure) {
      if (revision.current === expected) setError(failure.message || "APORIAX_ACCOUNT_REQUEST_FAILED");
      return null;
    } finally { pending.current = false; setBusy(false); }
  };
  return <AccountContext.Provider value={{ account, busy, error, api, setAccount, setError, signIn: () => perform("signIn"), refresh: () => perform("refresh"), signOut: () => perform("signOut") }}>{children}</AccountContext.Provider>;
}

export const useAccount = () => useContext(AccountContext) || unavailable;
