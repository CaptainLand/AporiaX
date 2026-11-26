// Legacy starter skins shipped with an internal upload label instead of a
// description. Match the verified palette revision, not a title anyone can use.
const legacySkins = {
  "63ab9eb49fd9045a467fd2fb671b2a22708438bb9cca0a7ad42bce0cff7ab6f2": [
    "深蓝黑底搭配明亮的橙色点缀，适合喜欢暖色高亮的深色界面。",
    "A deep blue-black theme with vivid orange accents for a warmer dark interface.",
  ],
  "c2f6f6e045847cff3a598985ec6d723d79e9a87b97c5bb41d8728f67c24969b5": [
    "以森林绿为底，搭配清新的翡翠绿点缀和浅色文字。",
    "A forest-green theme with fresh emerald accents and soft, light text.",
  ],
};

export function marketDescription(item, tr) {
  const summary = item.summary?.trim() || "";
  if (item.kind !== "skin" || (summary && !["基础配色快照", "基础颜色快照"].includes(summary.replace(/[。.]$/, "")))) {
    return summary;
  }
  return tr(...(Object.hasOwn(legacySkins,item.sha256) ? legacySkins[item.sha256] : [
    "AporiaX 界面配色主题，添加后可在「个性化」中切换。",
    "An AporiaX color theme you can switch to in Personalization after adding it.",
  ]));
}
