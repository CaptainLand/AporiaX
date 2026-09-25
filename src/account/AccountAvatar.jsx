import { useState } from "react";
import { CircleUserRound } from "lucide-react";
import { PROFILE_AVATARS_ENABLED } from "./avatar-feature.js";

export function AccountAvatar({ profile, compact = false }) {
  const [failed, setFailed] = useState("");
  const value = profile?.avatarDataUrl;
  const valid = typeof value === "string" && value.length <= 87406 && /^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value);
  return <span className={`local-account-avatar${compact ? " local-account-avatar--compact" : ""}`} aria-hidden="true">
    {PROFILE_AVATARS_ENABLED && valid && value !== failed ? <img src={value} alt="" onError={() => setFailed(value)} /> : <CircleUserRound size={compact ? 16 : 18} />}
  </span>;
}
