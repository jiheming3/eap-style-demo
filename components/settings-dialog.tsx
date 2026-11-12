"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelStatus } from "@/lib/types";
import { Icon } from "./icons";

export default function SettingsDialog({ status, onStatus, onClose }: { status: ModelStatus; onStatus: (status: ModelStatus) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [model, setModel] = useState(status.model);
  const [baseUrl, setBaseUrl] = useState(status.baseUrl);
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<"save" | "check" | null>(null);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const dirty = model.trim() !== status.model || baseUrl.trim().replace(/\/+$/, "") !== status.baseUrl || apiKey.length > 0;

  useEffect(() => { dialog.current?.showModal(); }, []);

  async function action(kind: "save" | "check") {
    setBusy(kind); setError(""); setMessage("");
    try {
      const response = await fetch(kind === "save" ? "/api/settings" : "/api/settings/check", {
        method: kind === "save" ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        ...(kind === "save" ? { body: JSON.stringify({ model, baseUrl, apiKey }) } : {}),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "操作未完成，请重试。");
      onStatus(result); setApiKey(""); setModel(result.model); setBaseUrl(result.baseUrl);
      setMessage(kind === "save" ? "已保存在本机。验证连接后，就可以开始聊天。" : "连接成功，可以开始对话了。");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "操作未完成，请重试。"); }
    finally { setBusy(null); }
  }

  return <dialog ref={dialog} className="settings-dialog" aria-labelledby="settings-title" onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }} onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className="dialog-head"><span className="dialog-symbol"><Icon name="settings" size={23} /></span><button className="icon-button" aria-label="关闭模型设置" onClick={onClose} disabled={Boolean(busy)}><Icon name="close" /></button></div>
    <h2 id="settings-title">连接你的模型</h2>
    <p className="dialog-intro">配置千问后，就可以体验真实的多轮对话。</p>
    <form onSubmit={(event) => { event.preventDefault(); void action("save"); }}>
      <label className="field-label" htmlFor="model-name">模型名称</label>
      <input id="model-name" value={model} onChange={(event) => setModel(event.target.value)} autoComplete="off" spellCheck={false} disabled={Boolean(busy)} required maxLength={120} />
      <label className="field-label" htmlFor="model-endpoint">接口地址 <span>Base URL</span></label>
      <input id="model-endpoint" type="url" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://你的工作空间.cn-beijing.maas.aliyuncs.com/compatible-mode/v1" autoComplete="off" spellCheck={false} disabled={Boolean(busy)} required />
      <p className="field-help">使用千问控制台对应地域的地址，以 /v1 结尾。</p>
      <label className="field-label" htmlFor="model-key">API Key {status.hasKey && <span className="saved-indicator"><Icon name="check" size={13} /> 已保存</span>}</label>
      <input id="model-key" type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={status.hasKey ? "留空沿用已保存的 Key" : "在这里粘贴你的 Key"} autoComplete="new-password" spellCheck={false} disabled={Boolean(busy)} required={!status.hasKey} maxLength={2048} />
      <div className="config-note"><Icon name="lock" size={16} /><p>Key 仅保存在本机配置文件中，不出现在对话和导出记录里。聊天内容会发送至你配置的千问服务。</p></div>
      {error && <div className="form-alert error" role="alert"><Icon name="info" size={17} />{error}</div>}
      {message && <div className="form-alert success" role="status"><Icon name="check" size={17} />{message}</div>}
      <div className="dialog-actions"><button type="button" className="secondary-button" disabled={Boolean(busy) || !status.configured || dirty} onClick={() => void action("check")}>{busy === "check" ? <span className="spinner" /> : <Icon name="refresh" size={16} />}验证连接</button><button type="submit" className="primary-button" disabled={Boolean(busy)}>{busy === "save" && <span className="spinner" />}保存配置<Icon name="chevron" size={15} /></button></div>
    </form>
    <div className="dialog-footer"><span>验证连接会发送一条简短的模型请求。</span><a href="https://help.aliyun.com/zh/model-studio/compatibility-of-openai-with-dashscope" target="_blank" rel="noreferrer">千问接入说明<Icon name="external" size={12} /></a></div>
  </dialog>;
}
