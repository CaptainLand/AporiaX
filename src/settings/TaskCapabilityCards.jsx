import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, ImagePlus, Sparkles } from "lucide-react";
import { resolveVisionCapability } from "../runtime-ui-core.js";
import { useI18n } from "../i18n";
import "../runtime-ui-enhancements.css";
import "../skill-status.css";

function sourceLabel(source, tr) {
  if (source === "project") return tr("项目", "Project");
  if (source === "user") return tr("用户", "User");
  return tr("内置", "Built-in");
}

function capabilityStatusText(capability, tr) {
  if (capability.mode === "native") {
    return tr(
      "当前模型配置为原生图片输入",
      "Current model is configured for native image input",
    );
  }
  if (capability.mode === "proxy") {
    const proxyName = capability.proxy?.modelName || capability.proxy?.modelId;
    return tr(
      `通过 ${proxyName} 自动识图`,
      `Images are automatically routed through ${proxyName}`,
    );
  }
  return tr(
    capability.cloudVisionStatus ? "尚未确认 Cloud 托管视觉就绪" : "当前模型未声明图片输入，也没有已配置的视觉代理",
    capability.cloudVisionStatus ? "Cloud managed vision readiness is not confirmed" : "Native image input is not declared and no configured vision proxy is available",
  );
}

function VisionCapabilityCard({ task, providers, onManageProviders }) {
  const { tr } = useI18n();
  const capability = useMemo(
    () => resolveVisionCapability(providers, task),
    [providers, task?.providerId, task?.modelId],
  );
  const available = capability.available;
  const proxyMode = capability.mode === "proxy";
  const nativeMode = capability.mode === "native";
  const mainModel =
    capability.mainModelName ||
    capability.mainModelId ||
    tr("当前模型", "Current model");
  const proxyModel =
    capability.proxy?.modelName || capability.proxy?.modelId || "";

  return (
    <section
      className={`aporiax-vision-capability ${available ? "ready" : "missing"}`}
    >
      <div className="aporiax-vision-label">
        {tr("视觉能力", "Vision capability")}
      </div>
      <div className="aporiax-vision-card">
        <div className="aporiax-vision-heading">
          <span className="aporiax-vision-icon">
            {available ? <Eye size={16} /> : <ImagePlus size={16} />}
          </span>
          <div>
            <strong>
              {available
                ? tr("图片输入已配置", "Image input configured")
                : tr("图片输入尚未就绪", "Image input not ready")}
            </strong>
            <span>{capabilityStatusText(capability, tr)}</span>
          </div>
        </div>

        {(nativeMode || proxyMode) && (
          <div className="aporiax-vision-route">
            <div>
              <span>{tr("主模型", "Main model")}</span>
              <strong>{mainModel}</strong>
            </div>
            {proxyMode && (
              <>
                <ArrowRight size={13} aria-hidden="true" />
                <div>
                  <span>{tr("视觉代理", "Vision proxy")}</span>
                  <strong>{proxyModel}</strong>
                </div>
              </>
            )}
            {nativeMode && <em>{tr("原生视觉", "Native vision")}</em>}
          </div>
        )}

        <p>
          {nativeMode
            ? tr(
                "图片会直接交给当前主模型处理，不需要额外视觉代理。",
                "Images go directly to the current main model; no extra vision proxy is needed.",
              )
            : proxyMode
              ? tr(
                  `上传图片时，AporiaX 会先调用 ${proxyModel} 解析，再把结果自动交给 ${mainModel} 继续思考与执行。`,
                  `When you attach an image, AporiaX asks ${proxyModel} to inspect it first, then passes the observation to ${mainModel} for reasoning and execution.`,
                )
              : tr(
                  capability.cloudVisionStatus ? "登录后请检查 Cloud 视觉配置及服务版本。未收到就绪结果时，不会显示或调用一个假定可用的模型。" : "自定义模型默认按原生视觉发图。若看图失败，会自动改为仅文本；也可在模型设置中手动选择。不会自动借用 Cloud 额度。",
                  capability.cloudVisionStatus ? "After signing in, check Cloud vision configuration and service version. An assumed model is not shown or called without readiness confirmation." : "Custom models default to native vision. If image reading fails, they switch to text only. You can also set this in model settings. Cloud quota is not used implicitly.",
                )}
        </p>

        {available && <p>{tr("配置状态不代表上游调用已验证；实际可用性以 API 返回为准。", "Configuration does not prove upstream availability; actual requests may still fail.")}</p>}

        <button type="button" onClick={onManageProviders}>
          {available
            ? tr("管理视觉模型", "Manage vision models")
            : tr("去添加视觉模型", "Add a vision model")}
          <ArrowRight size={13} />
        </button>
      </div>
    </section>
  );
}

function SkillCapabilityCard({ workspacePath }) {
  const { tr } = useI18n();
  const [state, setState] = useState({
    loading: true,
    skills: [],
    error: "",
  });

  useEffect(() => {
    let active = true;
    if (!window.desktop?.core?.skills) {
      setState({ loading: false, skills: [], error: "" });
      return () => {
        active = false;
      };
    }
    setState((current) => ({ ...current, loading: true, error: "" }));
    Promise.resolve(window.desktop.core.skills({ workspacePath: workspacePath || "" }))
      .then((data) => {
        if (!active) return;
        setState({
          loading: false,
          skills: Array.isArray(data?.skills) ? data.skills : [],
          error: "",
        });
      })
      .catch((error) => {
        if (!active) return;
        setState({
          loading: false,
          skills: [],
          error: String(
            error?.message ||
              error ||
              tr("Skill 发现失败", "Skill discovery failed"),
          ),
        });
      });
    return () => {
      active = false;
    };
  }, [workspacePath, tr]);

  const skills = state.skills;
  return (
    <section className="aporiax-skill-capability">
      <div className="aporiax-skill-label">Skills</div>
      <div className="aporiax-skill-card">
        <div className="aporiax-skill-heading">
          <span className="aporiax-skill-icon">
            <Sparkles size={15} />
          </span>
          <div>
            <strong>
              {state.loading
                ? tr("正在发现 Skills", "Discovering skills")
                : skills.length
                  ? tr(
                      `${skills.length} 个 Skill 可用`,
                      `${skills.length} skill${skills.length === 1 ? "" : "s"} available`,
                    )
                  : tr("未发现 Skill", "No skills discovered")}
            </strong>
            <span>
              {tr(
                "按任务自动匹配，也可用 /skill:name 手动启用",
                "Matched automatically per task, or activate one with /skill:name",
              )}
            </span>
          </div>
        </div>

        {state.error && <p className="aporiax-skill-error">{state.error}</p>}

        {skills.length > 0 ? (
          <div className="aporiax-skill-list">
            {skills.slice(0, 5).map((skill) => (
              <div
                className="aporiax-skill-item"
                key={`${skill.source}:${skill.name}`}
              >
                <div>
                  <strong>{skill.title || skill.name}</strong>
                  <span>{skill.name}</span>
                </div>
                <em>{sourceLabel(skill.source, tr)}</em>
                <small>
                  {skill.auto ? tr("自动", "Auto") : tr("手动", "Manual")}
                </small>
              </div>
            ))}
            {skills.length > 5 && (
              <div className="aporiax-skill-more">
                {tr(
                  `另有 ${skills.length - 5} 个`,
                  `${skills.length - 5} more`,
                )}
              </div>
            )}
          </div>
        ) : !state.loading ? (
          <div className="aporiax-skill-empty">
            <p>
              {tr(
                "创建 SKILL.md 后，AporiaX 只会在匹配到任务时加载完整指令，不会把所有 Skill 都塞进上下文。",
                "Add a SKILL.md and AporiaX will load its full instructions only when the task matches, instead of placing every skill in context.",
              )}
            </p>
            <code>.aporiax/skills/&lt;name&gt;/SKILL.md</code>
          </div>
        ) : null}

        <div className="aporiax-skill-footnote">
          <span>{tr("声明式 · 不执行 JS", "Declarative · no JS execution")}</span>
          <span>{tr("不扩大工具权限", "Does not expand tool permissions")}</span>
        </div>
      </div>
    </section>
  );
}

export function TaskCapabilityCards({ task, providers, onManageProviders }) {
  return (
    <>
      <VisionCapabilityCard
        task={task}
        providers={providers}
        onManageProviders={onManageProviders}
      />
      <SkillCapabilityCard workspacePath={task?.workspacePath || ""} />
    </>
  );
}
