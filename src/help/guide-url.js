export const USER_GUIDE_URL = "https://captainland.github.io/AporiaX_web/guide/";

export function userGuideUrl(section = "") {
  return section === "api-key" ? `${USER_GUIDE_URL}#api-key` : USER_GUIDE_URL;
}
