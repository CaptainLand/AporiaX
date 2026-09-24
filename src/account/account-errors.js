// Show actionable, non-sensitive messages instead of raw SSH stderr or URLs.
const errors = [
  ["BETA_CAPACITY_FULL", "20 个内测名额已满，已有内测账户仍可登录。", "All 20 beta places are taken. Existing members can still sign in."],
  ["BETA_ACCESS_DENIED", "此账户暂无内测访问权，请联系维护者。", "This account has no active beta access. Contact the operator."],
  ["APORIAX_ACCOUNT_CENTER_FAILED", "暂时无法打开账户中心，请检查默认浏览器后重试。", "Could not open the account center. Check your default browser and retry."],
  ["APORIAX_PRIVATE_CONFIG_INVALID", "本机私有连接配置无效，请重新检查配置。", "The local private connection profile is invalid."],
  ["APORIAX_PRIVATE_KEY_MISSING", "未找到本机 SSH 密钥。此预览包仅用于已配置连接的电脑。", "Local SSH key not found. This preview requires a configured computer."],
  ["APORIAX_PRIVATE_SSH_MISSING", "未安装 Windows OpenSSH 客户端，请在系统可选功能中安装。", "Install the Windows OpenSSH Client optional feature."],
  ["APORIAX_PRIVATE_PORT_BUSY", "预览端口被占用，请先关闭之前手动开启的 Cloud 预览，再点击登录。", "Preview ports are in use. Close the previous manual Cloud preview and retry."],
  ["APORIAX_PRIVATE_HOST_CHANGED", "服务器身份与保存的公钥不符，已停止连接。请核实服务器后再更新配置。", "Server identity mismatch. Verify the server before updating the pinned key."],
  ["APORIAX_PRIVATE_SSH_AUTH_FAILED", "SSH 身份验证失败，请检查密钥是否已授权、是否需要口令。", "SSH authentication failed. Check key authorization and passphrase requirements."],
  ["APORIAX_PRIVATE_WEB_MISSING", "此软件包缺少私有预览网页，请使用新版一键预览包。", "Private Web assets are missing. Use the new one-click preview package."],
  ["APORIAX_PRIVATE_", "暂时无法连接私有 Cloud。请检查网络及服务器状态，然后重试。", "Cannot connect to private Cloud. Check the network and server, then retry."],
  ["APORIAX_CLOUD_ENDPOINTS_NOT_CONFIGURED", "Cloud 登录尚未配置。私有预览需要本机连接配置；也可以添加自己的 API。", "Cloud sign-in is not configured. Set up private access or use your own API."],
  ["DESKTOP_LOGIN_TIMEOUT", "网页授权已超时，请重新点击登录并在浏览器中完成确认。", "Browser authorization timed out. Sign in again and confirm in the browser."],
];
export function accountErrorText(error, tr) {
  if (!error) return "";
  const found = errors.find(([code]) => String(error).includes(code));
  return found ? tr(found[1], found[2]) : tr("登录未完成，请检查网络后重试。", "Sign-in was not completed. Check your connection and retry.");
}
