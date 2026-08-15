import React, { useEffect, useMemo, useState } from "react";
import { ArrowRight, Eye, ImagePlus, Sparkles } from "lucide-react";
import { Switch } from "../components/Controls.jsx";
import { resolveVisionCapability } from "../runtime-ui-core.js";
import { useI18n } from "../i18n";
import "../runtime-ui-enhancements.css";
import "../skill-status.css";

const APORIA_CLOUD_PROVIDER_ID = "aporia-cloud";
const CLOUD_VISION_GUARD_RATIO = 0.2;

function sourceLabel(source, tr) {
  if (source === "project") return tr("项目", "Project");
  if (source === "user") return tr("用户", "User");
  return tr("内置", "Built-in");
}

function capabilityStatusText(capability, tr) {
  if (capability.mode === "native") {
    return tr(
      "当前模型原生支持图片输入",
      "Current model supports images natively",
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
    "当前主模型不支持图片，且尚未配置视觉模型",
    "The current main model is text-only and no vision model is configured",
  );
}

function VisionCapabilityCard({ task, providers, onManageProviders }) {
  const { tr } = useI18n();
  const capability = useMemo(
    () => resolveVisionCapability(providers, task),
    [providers, task?.providerId, task?.modelId],
  );
  const [cloudSettings, setCloudSettings] = useState({
    loading: true,
    cloudVisionEnabled: true,
    cloudVisionQuotaGuard: true,
  });
  const [settingsError, setSettingsError] = useState("");

  useEffect(() => {
    let active = true;
    const api = window.desktop?.vision;
    if (!api?.getSettings) {
      setCloudSettings((current) => ({ ...current, loading: false }));
      return () => {
        active = false;
      };
    }
    Promise.resolve(api.getSettings())
      .then((settings) => {
        if (!active) return;
        setCloudSettings({
          loading: false,
          cloudVisionEnabled: settings?.cloudVisionEnabled !== false,
          cloudVisionQuotaGuard: settings?.cloudVisionQuotaGuard !== false,
        });
      })
      .catch((error) => {
        if (!active) return;
        setCloudSettings((current) => ({ ...current, loading: false }));
        setSettingsError(
          String(error?.message || tr("无法读取视觉设置", "Unable to read vision settings")),
        );
      });
    return () => {
      active = false;
    };
  }, [tr]);

  const updateCloudSettings = async (patch) => {
    const previous = cloudSettings;
    const optimistic = { ...cloudSettings, ...patch, loading: false };
    setCloudSettings(optimistic);
    setSettingsError("");
    try {
      const saved = await window.desktop?.vision?.setSettings?.(patch);
      if (saved) {
        setCloudSettings({
          loading: false,
          cloudVisionEnabled: saved.cloudVisionEnabled !== false,
          cloudVisionQuotaGuard: saved.cloudVisionQuotaGuard !== false,
        });
      }
    } catch (error) {
      setCloudSettings(previous);
      setSettingsError(
        String(error?.message || tr("无法保存视觉设置", "Unable to save vision settings")),
      );
    }
  };

  const cloudProxy =
    capability.mode === "proxy" &&
    capability.proxy?.providerId === APORIA_CLOUD_PROVIDER_ID;
  const hybridCloudProxy =
    cloudProxy && capability.providerId !== APORIA_CLOUD_PROVIDER_ID;
  const rawRemainingRatio = capability.proxy?.quotaRemainingRatio;
  const parsedRemainingRatio =
    rawRemainingRatio === null ||
    rawRemainingRatio === undefined ||
    rawRemainingRatio === ""
      ? null
      : Number(rawRemainingRatio);
  const hasRemainingRatio = Number.isFinite(parsedRemainingRatio);
  const remainingRatio = hasRemainingRatio ? parsedRemainingRatio : null;
  const quotaProtected = Boolean(
    hybridCloudProxy &&
      cloudSettings.cloudVisionEnabled &&
      cloudSettings.cloudVisionQuotaGuard &&
      hasRemainingRatio &&
      remainingRatio <= CLOUD_VISION_GUARD_RATIO,
  );
  const cloudDisabled =
    hybridCloudProxy && !cloudSettings.cloudVisionEnabled;
  const nativeMode = capability.mode === "native";
  const proxyMode =
    capability.mode === "proxy" && !cloudDisabled && !quotaProtected;
  const available = nativeMode || proxyMode;
  const mainModel =
    capability.mainModelName ||
    capability.mainModelId ||
    tr("当前模型", "Current model");
  const proxyModel =
    capability.proxy?.modelName || capability.proxy?.modelId || "";

  const statusText = cloudDisabled
    ? tr(
        "Cloud 视觉增强已关闭；主模型仍保持本地运行",
        "Cloud vision enhancement is off; the main model still runs locally",
      )
    : quotaProtected
      ? tr(
          "Cloud 剩余额度已进入 20% 保护区，自动视觉调用已暂停",
          "Cloud quota is in the protected bottom 20%; automatic vision calls are paused",
        )
      : capabilityStatusText(capability, tr);

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
                ? tr("图片识别已启用", "Image recognition enabled")
                : tr("图片识别当前未启用", "Image recognition is currently unavailable")}
            </strong>
            <span>{statusText}</span>
          </div>
        </div>

        {(nativeMode || capability.mode === "proxy") && (
          <div className="aporiax-vision-route">
            <div>
              <span>{tr("主模型", "Main model")}</span>
              <strong>{mainModel}</strong>
            </div>
            {capability.mode === "proxy" && (
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
            : cloudProxy
              ? tr(
                  `主推理继续由 ${mainModel} 执行。只有附带图片时，AporiaX 才会把单张图片交给 ${proxyModel}，再把视觉观察结果返回给主模型。`,
                  `Main reasoning stays on ${mainModel}. Only attached images are sent one at a time to ${proxyModel}, and its visual observation is returned to the main model.`,
                )
              : proxyMode
                ? tr(
                    `上传图片时，AporiaX 会先调用 ${proxyModel} 解析，再把结果自动交给 ${mainModel} 继续思考与执行。`,
                    `When you attach an image, AporiaX asks ${proxyModel} to inspect it first, then passes the observation to ${mainModel} for reasoning and execution.`,
                  )
                : tr(
                    "添加一个视觉模型后，AporiaX 会自动将它用于 DeepSeek 等非图像模型的识图，无需切换主思考模型。",
                    "Add a vision model and AporiaX will automatically use it for text-only models such as DeepSeek, without changing your main reasoning model.",
                  )}
        </p>

        {hybridCloudProxy && (
          <div className="aporiax-vision-controls">
            <div className="aporiax-vision-control-row">
              <div>
                <strong>{tr("Cloud 视觉增强", "Cloud vision enhancement")}</strong>
                <span>
                  {tr(
                    "仅在本地/自定义文本模型需要看图时调用 Qwen3.5 Flash",
                    "Use Qwen3.5 Flash only when a local/custom text model needs to inspect an image",
                  )}
                </span>
              </div>
              <Switch
                checked={cloudSettings.cloudVisionEnabled}
                disabled={cloudSettings.loading}
                label={tr("Cloud 视觉增强", "Cloud vision enhancement")}
                onChange={(enabled) =>
                  void updateCloudSettings({ cloudVisionEnabled: enabled })
                }
              />
            </div>
            <div className="aporiax-vision-control-row">
              <div>
                <strong>{tr("20% 低额度保护", "20% low-quota guard")}</strong>
                <span>
                  {hasRemainingRatio
                    ? tr(
                        `最近同步 Cloud 剩余约 ${Math.round(remainingRatio * 100)}%；真正调用前会刷新额度，低于或等于 20% 时停止自动识图`,
                        `Last synced Cloud quota is about ${Math.round(remainingRatio * 100)}%; AporiaX refreshes it before the actual call and pauses automatic vision at or below 20%`,
                      )
                    : tr(
                        "真正调用前刷新 Cloud 额度；低于或等于 20% 时停止自动识图",
                        "Refresh Cloud quota before the actual call; pause automatic vision at or below 20%",
                      )}
                </span>
              </div>
              <Switch
                checked={cloudSettings.cloudVisionQuotaGuard}
                disabled={cloudSettings.loading || !cloudSettings.cloudVisionEnabled}
                label={tr("20% 低额度保护", "20% low-quota guard")}
                onChange={(enabled) =>
                  void updateCloudSettings({ cloudVisionQuotaGuard: enabled })
                }
              />
            </div>
            {settingsError && <p className="aporiax-vision-settings-error">{settingsError}</p>}
          </div>
        )}

        {!capability.available && (
          <div className="aporiax-vision-recommendation">
            <span>{tr("推荐", "Recommended")}</span>
            <strong>Qwen3.5-Flash</strong>
          </div>
        )}

        <button type="button" onClick={onManageProviders}>
          {capability.available
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
