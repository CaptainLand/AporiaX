import { useEffect, useState } from "react";
import { Check, GitBranch, Github, ExternalLink } from "lucide-react";
import { SideChatDialog } from "./SideChatDialog.jsx";
import { useI18n } from "../i18n";
import "./side-chat.css";

export function GitSetupDialog({ kind, state, workbench, busy, error, onAction, onClose }) {
  const { tr } = useI18n();
  const [section, setSection] = useState("remote"), [settings, setSettings] = useState(null), [auth, setAuth] = useState(null);
  const [loadError, setLoadError] = useState(""), [version, setVersion] = useState(0), [loading, setLoading] = useState(false);
  const [branch, setBranch] = useState(kind === "init" ? "main" : kind === "publish" ? state.branch : "");
  const [url, setUrl] = useState(""), [remote, setRemote] = useState(state.remotes?.includes("origin") ? "origin" : state.remotes?.[0] || "origin");
  const [name, setName] = useState(""), [email, setEmail] = useState(""), [repo, setRepo] = useState(""), [visibility, setVisibility] = useState("private"), [addIgnore, setAddIgnore] = useState(true);
  const [loginBusy, setLoginBusy] = useState(false);
  const pending = Boolean(busy) || loginBusy || loading;
  const dirtyEditors = workbench.dirty.current.size > 0;
  useEffect(() => {
    let disposed = false;
    if (!state.repository || state.readOnly || !["setup", "branches"].includes(kind)) return;
    setLoading(true); setLoadError("");
    workbench.request({ action: "git", operation: "settings" }).then((result) => {
      if (disposed) return;
      setSettings(result); setName(result.name); setEmail(result.email);
      setUrl(result.remotes.find((item) => item.name === remote)?.url || "");
    }).catch((failure) => { if (!disposed) setLoadError(failure.message); }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [kind, version]);
  useEffect(() => {
    if (kind !== "setup" || section !== "github") return;
    let disposed = false; setAuth(null);
    workbench.request({ action: "git", operation: "github-status" }).then((result) => { if (!disposed) setAuth(result); })
      .catch((failure) => { if (!disposed) setAuth({ message: failure.message }); });
    return () => { disposed = true; };
  }, [kind, section, version]);
  const act = async (operation, extra = {}, close = false) => {
    if ((operation === "branch-switch" || operation === "pull") && dirtyEditors) { setLoadError(tr("侧栏有未保存文件，请先保存再切换或拉取。", "Save open editor drafts before switching or pulling.")); return; }
    if (await onAction(operation, extra)) {
      if (close) onClose(); else setVersion((value) => value + 1);
    }
  };
  const submit = (operation, extra, close) => (event) => { event.preventDefault(); void act(operation, extra, close); };
  const input = (label, value, setter, props = {}) => <label className="git-field"><span>{label}</span><input value={value} onChange={(event) => setter(event.target.value)} disabled={pending} {...props} /></label>;
  const titles = { setup: tr("仓库设置", "Repository settings"), branches: tr("分支", "Branches"), init: tr("初始化 Git", "Initialize Git"), clone: tr("克隆仓库", "Clone repository"), publish: tr("发布分支", "Publish branch") };
  return <SideChatDialog title={titles[kind]} subtitle={state.root} onClose={onClose}>
    <div className="git-setup">
      {(error || loadError) && <p className="git-form-error" role="alert">{error || loadError}</p>}
      {(pending || loading) && <p className="git-hint" role="status">{tr("正在处理，请稍候…", "Working, please wait…")}</p>}
      {kind === "setup" && <nav className="git-settings-tabs" aria-label={tr("仓库设置分类", "Repository settings sections")}>{[["remote", "远程", "Remotes"], ["identity", "提交身份", "Identity"], ["github", "GitHub", "GitHub"]].map(([id, zh, en]) => <button key={id} aria-pressed={section === id} onClick={() => setSection(id)}>{tr(zh, en)}</button>)}</nav>}
      {kind === "init" && <form onSubmit={submit("init", { branch, addIgnore }, true)}>
        <p className="git-hint">{tr("仅在当前工作区创建本地版本记录，不上传任何文件。", "Create local version history in this workspace. No uploads.")}</p>
        {input(tr("初始分支", "Initial branch"), branch, setBranch, { required: true, maxLength: 240 })}
        <label className="git-checkbox"><input type="checkbox" checked={addIgnore} onChange={(event) => setAddIgnore(event.target.checked)} disabled={pending} />{tr("添加基础 .gitignore（已有文件不覆盖）", "Add a basic .gitignore without overwriting an existing file")}</label>
        <p className="git-hint">{tr("忽略 .env、node_modules、dist、release 和 .tmp；提交前仍需检查密钥等敏感文件。", "Ignores .env, node_modules, dist, release and .tmp; still review sensitive files before committing.")}</p>
        <button className="git-primary" disabled={pending}>{tr("初始化当前工作区", "Initialize workspace")}</button>
      </form>}
      {kind === "clone" && <form onSubmit={submit("clone", { url }, true)}>
        <p className="git-hint">{tr("克隆到上方的当前工作区，要求目录为空。私有仓库请先在 GitHub 页登录。失败时不会自动删除残留文件。", "Clone into the empty workspace above. Sign in first for private repositories. Failed clones are not automatically deleted.")}</p>
        {input(tr("仓库地址", "Repository URL"), url, setUrl, { placeholder: "https://github.com/owner/repo.git", required: true, maxLength: 2048 })}
        <button className="git-primary" disabled={pending || !state.empty}>{tr("克隆到当前工作区", "Clone into workspace")}</button>
      </form>}
      {kind === "branches" && <>
        <div className="git-branch-list" aria-label={tr("本地分支", "Local branches")}>{settings?.branches.map((item) => <button key={item} disabled={pending || item === state.branch || dirtyEditors} onClick={() => void act("branch-switch", { branch: item }, true)}><GitBranch size={14} /><span>{item}</span>{item === state.branch && <Check size={14} />}</button>)}</div>
        <p className="git-hint">{tr("切换要求没有未提交改动和未保存草稿。新建分支会保留当前改动；Agent 正在运行时请先停止任务。", "Switch only with clean files and saved drafts. New branches retain changes. Stop active Agent work first.")}</p>
        <form onSubmit={submit("branch-create", { branch }, true)}>
          {input(tr("新分支名称", "New branch name"), branch, setBranch, { placeholder: "feature/new-ui", required: true, maxLength: 240 })}
          <button className="git-primary" disabled={pending || !state.head}>{tr("创建并切换", "Create and switch")}</button>
        </form>
      </>}
      {kind === "publish" && <form onSubmit={submit("push", { remote, branch }, true)}>
        <p className="git-hint">{tr("仅上传当前分支的已有提交并设置上游，不自动暂存或提交文件。下一步会确认上传目标。", "Push existing commits and set upstream. No automatic staging or commit. The destination will be confirmed next.")}</p>
        <div className="git-choice-row" aria-label={tr("选择远程", "Choose remote")}>{state.remotes.map((item) => <button type="button" key={item} aria-pressed={remote === item} disabled={pending} onClick={() => setRemote(item)}>{item}</button>)}</div>
        {input(tr("远程分支名称", "Remote branch name"), branch, setBranch, { required: true, maxLength: 240 })}
        <button className="git-primary" disabled={pending || !state.head || !state.remotes.length}>{tr("确认发布目标", "Confirm destination")}</button>
      </form>}
      {kind === "setup" && section === "remote" && <>
        {!state.repository ? <p className="git-hint">{tr("请先初始化或克隆仓库。", "Initialize or clone a repository first.")}</p> : <form onSubmit={submit("remote-save", { remote, url })}>
          <div className="git-remote-list">{settings?.remotes.map((item) => <button type="button" key={item.name} onClick={() => { setRemote(item.name); setUrl(item.url); }}><strong>{item.name}</strong><span>{item.url}</span>{item.pushUrl !== item.url && <small>push: {item.pushUrl}</small>}</button>)}</div>
          {input(tr("远程名称", "Remote name"), remote, setRemote, { required: true, maxLength: 100 })}
          {input(tr("仓库地址", "Repository URL"), url, setUrl, { placeholder: "https://github.com/owner/repo.git", required: true, maxLength: 2048 })}
          <p className="git-hint">{tr("保存只关联地址，不会上传代码。已有同名 remote 将请求确认修改。", "Saving links the remote without uploading code. Existing remotes require confirmation to change.")}</p>
          <button className="git-primary" disabled={pending || loading}>{tr("保存远程关联", "Save remote")}</button>
        </form>}
      </>}
      {kind === "setup" && section === "identity" && <form onSubmit={submit("identity-save", { name, email })}>
        <p className="git-hint">{tr("这是提交记录中的署名，不是 GitHub 登录；只修改当前仓库配置。可使用 GitHub 提供的 noreply 邮箱。", "Commit author, not GitHub login. Changes only this repository; a GitHub noreply email can be used.")}</p>
        {input(tr("提交者姓名", "Author name"), name, setName, { required: true, maxLength: 100 })}
        {input(tr("提交者邮箱", "Author email"), email, setEmail, { required: true, type: "email", maxLength: 254 })}
        <button className="git-primary" disabled={pending || loading || !state.repository}>{tr("保存提交身份", "Save identity")}</button>
      </form>}
      {kind === "setup" && section === "github" && <>
        <div className="git-account"><Github size={23} /><div><strong>{auth?.authenticated ? auth.login : tr("连接 GitHub", "Connect GitHub")}</strong><p>{auth?.message || tr("正在检查登录状态…", "Checking sign-in…")}</p></div></div>
        <div className="git-choice-row">
          <button type="button" disabled={pending} onClick={() => setVersion((value) => value + 1)}>{tr("刷新登录状态", "Refresh sign-in")}</button>
          {!auth?.authenticated && <button type="button" disabled={pending || auth?.available === false || !auth} onClick={async () => {
            setLoginBusy(true);
            try { if (await workbench.create("terminal", "github-login")) onClose(); }
            finally { setLoginBusy(false); }
          }}><ExternalLink size={13} />{tr("浏览器登录", "Browser sign-in")}</button>}
        </div>
        <p className="git-hint">{tr("打开交互终端后按提示继续，在系统浏览器授权；完成后回到此处刷新。不会将密码或令牌发送给模型。需安装 GitHub CLI (gh)。", "Continue in the interactive terminal and authorize in your system browser. Return here to refresh. No passwords/tokens are sent to the model. Requires GitHub CLI (gh).")}</p>
        {auth?.authenticated && <form className="git-publish-form" onSubmit={submit("github-create", { name: repo, visibility, remote })}>
          <h3>{tr("创建 GitHub 仓库", "Create GitHub repository")}</h3>
          {input(tr("用户名 / 仓库名", "Owner / repository"), repo, setRepo, { placeholder: `${auth.login}/my-project`, required: true, maxLength: 140 })}
          {input(tr("关联远程名称", "Remote name"), remote, setRemote, { required: true, maxLength: 100 })}
          <div className="git-choice-row" aria-label={tr("仓库可见性", "Repository visibility")}>{[["private", "私有", "Private"], ["public", "公开", "Public"]].map(([id, zh, en]) => <button type="button" key={id} aria-pressed={visibility === id} disabled={pending} onClick={() => setVisibility(id)}>{tr(zh, en)}</button>)}</div>
          <p className="git-hint">{tr("只创建并关联，不自动推送。先完成本地首次提交；创建后再点击“发布分支”。", "Create and link only, without pushing. Make a local commit first, then publish the branch separately.")}</p>
          <button className="git-primary" disabled={pending || !state.head || state.remotes?.includes(remote)}>{tr("创建并关联", "Create and link")}</button>
          {state.remotes?.includes(remote) && <p className="git-hint">{tr("此远程名称已存在，请使用其他名称，或直接向已有远程发布分支。", "Remote name already exists. Choose another name or publish to the existing remote.")}</p>}
        </form>}
      </>}
    </div>
  </SideChatDialog>;
}
