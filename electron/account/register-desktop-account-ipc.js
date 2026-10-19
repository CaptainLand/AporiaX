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
  const parent=BrowserWindow.getFocusedWindow(),options={type:'question',title:'保存社区资源',message:`将“${info.title}”保存到本机 AporiaX？`,detail:`账号：${info.accountName}\n来源修订：r${info.revision}\nSHA-256：${info.sha256}\n\n同名另存，不覆盖现有资源。Skill 不自动触发；MCP / Agent 默认禁用；配色不自动应用。不安装依赖或执行指令。`,buttons:['取消','确认保存'],defaultId:0,cancelId:0,noLink:true};
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
app.whenReady().then(async()=>{
  const account=getDesktopAccountRuntime();
  const bridge=await startCommunityWebBridge({repository:localRepository(),allowedOrigins:[new URL(account.webBaseUrl).origin,...(!app.isPackaged?['http://127.0.0.1:5199']:[])]});
  if(quitting)await bridge.close();else communityBridge=bridge;
}).catch(error=>{console.warn(error.code==='EADDRINUSE'?'Community web sync unavailable: local port already in use.':'Community web sync could not start.');});
app.on("before-quit", () => {
  quitting=true;void communityBridge?.close();
  runtime?.close();
});
