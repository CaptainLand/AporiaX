export const USER_GUIDE_URL = "https://aporiax.cloud/guide/";

export function userGuideUrl(section = "") {
  return section === "api-key" ? `${USER_GUIDE_URL}#api-key` : USER_GUIDE_URL;
}
