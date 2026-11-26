import { handleTrustedIpc } from "../security/trusted-ipc.js";
import { app, ipcMain, BrowserWindow, dialog } from "electron";
import { createLocalRepositorySync } from '../community/local-repository.js';
import { startCommunityWebBridge } from '../community/web-bridge.js';
import { createDesktopAccountRuntime } from "./desktop-account-runtime.js";
import { privateCloudOptions } from "./private-cloud-bridge.js";
import { join } from "node:path";
import {createCommunityReceiver} from '../community/receive.js';
import {appearanceStore} from '../appearance/runtime.js';
import {roleSettingsStore} from '../harness/role-settings.js';

let runtime = null;
let repository=null,communityBridge=null,quitting=false;
const localRepository=()=>repository||(repository=createLocalRepositorySync({userDataDirectory:app.getPath('userData'),account:getDesktopAccountRuntime(),receiver:createCommunityReceiver({root:app.getPath('userData'),appearanceStore,roleStore:()=>roleSettingsStore(app.getPath('userData'))}),confirmReceive:async info=>{
  const parent=BrowserWindow.getFocusedWindow(),options={type:'question',title:'保存社区资源',message:`将“${info.title}”保存到本机 AporiaX？`,detail:`账号：${info.accountName}\n来源修订：r${info.revision}\nSHA-256：${info.sha256}\n\n${info.market?'同时保存到当前账号的私有社区仓库。\n':''}同名另存，不覆盖现有资源。Skill 不自动触发；MCP / Agent 默认禁用；配色不自动应用。不安装依赖或执行指令。`,buttons:['取消','确认保存'],defaultId:0,cancelId:0,noLink:true};
  return (parent?await dialog.showMessageBox(parent,options):await dialog.showMessageBox(options)).response===1;
},confirmSubmissionAction:async ({title,action,id})=>{
  const unpublish=action==='unpublish',label=unpublish?'下架作品':'撤回投稿';
  const parent=BrowserWindow.getFocusedWindow(),options={type:'question',title:label,message:`确认${unpublish?'下架':'撤回'}“${title}”？`,
    detail:`投稿编号：${id.slice(0,8)}\n\n`+(unpublish?'作品将停止公开展示和新增导入。已经保存的私有仓库和本机副本不会删除。':'投稿将停止审核。已使用的投稿次数不会退回。'),
    buttons:['取消',label],defaultId:0,cancelId:0,noLink:true};
  return (parent?await dialog.showMessageBox(parent,options):await dialog.showMessageBox(options)).response===1;
},confirm:async info=>{
  const parent=BrowserWindow.getFocusedWindow();
  const options={type:'question',title:'同步到个人仓库',message:`将全部 ${info.items.length} 项可同步配置上传到 ${info.accountName} 的私有仓库？`,detail:`目标：${info.destination}\n\n${info.items.slice(0,10).map(item=>`${item.title} · ${item.kind}`).join('\n')}${info.items.length>10?'\n…其余 '+(info.items.length-10)+' 项':''}\n\nMCP 凭据/本机路径会脱敏；配色不含图片；Agent 不含权限和项目知识。${info.skipped?.length?'\n另有 '+info.skipped.length+' 项不支持或未通过安全检查，不会上传。':''}\n\n由网页手动发起，不自动公开，不覆盖本地；云端已有快照会更新。取消则不上传。`,buttons:['取消','确认同步'],defaultId:0,cancelId:0,noLink:true};
  const result=parent?await dialog.showMessageBox(parent,options):await dialog.showMessageBox(options);return result.response===1;
}}));

export function getDesktopAccountRuntime() {
  if (!runtime) runtime = createDesktopAccountRuntime(privateCloudOptions({
    userDataPath: app.getPath("userData"),
    webRoot: app.isPackaged ? join(process.resourcesPath, "private-cloud-web")
      : join(app.getAppPath(), ".tmp", "aporiax-web-guide", ".tmp", "private-preview-web"),
  }));
  return runtime;
}

handleTrustedIpc(ipcMain, "account:get", () => getDesktopAccountRuntime().getSnapshot());
handleTrustedIpc(ipcMain, "account:sign-in", () => getDesktopAccountRuntime().startBrowserLogin());
handleTrustedIpc(ipcMain, "account:open-center", () => getDesktopAccountRuntime().openAccountCenter());
handleTrustedIpc(ipcMain, "account:request-history", (_event, input) => getDesktopAccountRuntime().getRequestHistory(input));
handleTrustedIpc(ipcMain, "account:refresh", () => getDesktopAccountRuntime().refresh());
handleTrustedIpc(ipcMain, "account:avatar-template", (_event,input) => getDesktopAccountRuntime().setAvatarTemplate(input));
handleTrustedIpc(ipcMain, "account:sign-out", () => getDesktopAccountRuntime().signOut());
const marketErrors = new Set([
  'DESKTOP_ACCOUNT_SIGNED_OUT', 'COMMUNITY_ACCOUNT_CHANGED', 'COMMUNITY_RULES_REQUIRED',
  'COMMUNITY_REPOSITORY_CONFLICT', 'COMMUNITY_DOWNLOAD_PERMISSION_REQUIRED', 'COMMUNITY_NOT_FOUND',
  'COMMUNITY_SYNC_BUSY', 'COMMUNITY_REPOSITORY_FULL', 'COMMUNITY_NOT_ENABLED', 'COMMUNITY_CATALOG_TOO_LARGE',
  'COMMUNITY_INVALID_RESOURCE', 'COMMUNITY_SECRET_DETECTED', 'COMMUNITY_LOCAL_CONFLICT',
  'COMMUNITY_QUOTA_EXHAUSTED', 'COMMUNITY_RATE_LIMITED', 'COMMUNITY_IDEMPOTENCY_CONFLICT', 'COMMUNITY_INVALID_UPLOAD',
  'COMMUNITY_UPLOAD_SOURCE_CHANGED', 'COMMUNITY_BUILTIN_RESOURCE', 'COMMUNITY_IMPORTED_RESOURCE',
  'COMMUNITY_LOCAL_RESOURCE_NOT_FOUND', 'COMMUNITY_SKILL_PACKAGE_NOT_SUPPORTED', 'COMMUNITY_UNSAFE_RESOURCE',
  'COMMUNITY_RESOURCE_TOO_LARGE', 'COMMUNITY_FILE_TOO_LARGE', 'COMMUNITY_SKILL_FORMAT',
  'COMMUNITY_MANIFEST_INVALID', 'COMMUNITY_THEME_CONTRAST', 'COMMUNITY_TEXT_REQUIRED',
  'COMMUNITY_DUPLICATE_SUBMISSION', 'COMMUNITY_REVISION_CONFLICT', 'COMMUNITY_MODERATION_LOCKED',
]);
const marketIpc = operation => async (_event,input) => {
  try { return await operation(input); }
  catch(error) {
    const message=String(error?.message||'').split(':')[0];
    throw Error(marketErrors.has(message)?message:error?.status===401?'DESKTOP_ACCOUNT_SIGNED_OUT':'COMMUNITY_MARKET_UNAVAILABLE');
  }
};
handleTrustedIpc(ipcMain,"community:market-list",marketIpc(accountId=>localRepository().marketCatalog(accountId)));
handleTrustedIpc(ipcMain,"community:market-add",marketIpc(input=>localRepository().marketAdd(input)));
handleTrustedIpc(ipcMain,"community:market-open",marketIpc(accountId=>getDesktopAccountRuntime().openCommunity(accountId)));
handleTrustedIpc(ipcMain,"community:market-upload-options",marketIpc(accountId=>localRepository().marketUploadOptions(accountId)));
handleTrustedIpc(ipcMain,"community:market-upload-preview",marketIpc(input=>localRepository().marketUploadPreview(input)));
handleTrustedIpc(ipcMain,"community:market-submit",marketIpc(input=>localRepository().marketSubmit(input)));
handleTrustedIpc(ipcMain,"community:market-mine",marketIpc(input=>localRepository().marketMine(input)));
handleTrustedIpc(ipcMain,"community:market-manage",marketIpc(input=>localRepository().marketManage(input)));
app.whenReady().then(async()=>{
  const account=getDesktopAccountRuntime();
  const bridge=await startCommunityWebBridge({repository:localRepository(),allowedOrigins:[new URL(account.webBaseUrl).origin,...(!app.isPackaged?['http://127.0.0.1:5199']:[])]});
  if(quitting)await bridge.close();else communityBridge=bridge;
}).catch(error=>{console.warn(error.code==='EADDRINUSE'?'Community web sync unavailable: local port already in use.':'Community web sync could not start.');});
app.on("before-quit", () => {
  quitting=true;void communityBridge?.close();
  runtime?.close();
});
