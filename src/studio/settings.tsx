import { Check, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, Busy, ErrorNote, primaryBtn, secondaryBtn } from "./edit";

// Which AI the studio uses: provider, model and key. The key is stored in the
// user's home folder by the Meld server and never sent back to the browser.

type Provider = "anthropic" | "openai" | "openai-compatible";

interface AgentStatus {
  configured: boolean;
  provider?: Provider;
  model?: string;
  baseUrl?: string;
  fallbacks?: boolean;
  key?: string;
}

const MODELS: Record<Provider, string[]> = {
  anthropic: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-4-5", "claude-fable-5-1"],
  openai: ["gpt-5", "gpt-5-mini"],
  "openai-compatible": [],
};

export function useAgentStatus(): [AgentStatus | null, () => void] {
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const load = () => {
    fetch("/_meld/agent")
      .then((r) => r.json())
      .then(setStatus)
      .catch(() => setStatus({ configured: false }));
  };
  useEffect(load, []);
  return [status, load];
}

export function SettingsDialog({ status, close, saved }: { status: AgentStatus | null; close: () => void; saved: () => void }) {
  const [provider, setProvider] = useState<Provider>(status?.provider ?? "anthropic");
  const [model, setModel] = useState(status?.model ?? "claude-opus-5-5");
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(status?.baseUrl ?? "");
  const [fallbacks, setFallbacks] = useState(status?.fallbacks ?? true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const save = async () => {
    await api("/_meld/agent", { provider, model, apiKey: apiKey || undefined, baseUrl: baseUrl || undefined, fallbacks }, "PUT");
    setApiKey("");
    saved();
  };
  const act = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    setOk(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const input = "w-full rounded-md border border-gray-200 px-2 py-1.5 text-[13px] outline-none focus:border-blue-400";
  const label = "mb-1 block text-[11px] font-semibold uppercase tracking-wide text-gray-500";
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={close}>
      <div className="meld-card w-[460px] p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <div className="text-[16px] font-semibold text-gray-800">AI agent</div>
          <button onClick={close} className="rounded p-1 text-gray-400 hover:bg-gray-100">
            <X size={16} />
          </button>
        </div>
        <div className="mt-1 text-[12px] text-gray-500">The agent writes explanations and turns your changes into Meld. Meld checks every change before it's saved.</div>

        <div className="mt-4 space-y-3">
          <div>
            <span className={label}>Provider</span>
            <div className="flex gap-2">
              {(["anthropic", "openai", "openai-compatible"] as Provider[]).map((p) => (
                <button
                  key={p}
                  onClick={() => {
                    setProvider(p);
                    setModel(MODELS[p][0] ?? "");
                  }}
                  className={`flex-1 rounded-md border px-2 py-1.5 text-[12px] ${provider === p ? "border-blue-400 bg-blue-50 font-semibold text-blue-700" : "border-gray-200 text-gray-600 hover:bg-gray-50"}`}
                >
                  {p === "anthropic" ? "Anthropic" : p === "openai" ? "OpenAI" : "OpenAI-compatible"}
                </button>
              ))}
            </div>
          </div>
          {provider === "openai-compatible" && (
            <label className="block">
              <span className={label}>Base URL</span>
              <input className={input} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://localhost:11434/v1" />
            </label>
          )}
          <label className="block">
            <span className={label}>Model</span>
            <input className={input} list="meld-models" value={model} onChange={(e) => setModel(e.target.value)} />
            <datalist id="meld-models">
              {MODELS[provider].map((m) => (
                <option key={m} value={m} />
              ))}
            </datalist>
          </label>
          <label className="block">
            <span className={label}>API key</span>
            <input
              className={`${input} meld-code`}
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={status?.configured && status.provider === provider ? `Leave empty to keep the current key (${status.key})` : provider === "anthropic" ? "sk-ant-… (or leave empty to use ANTHROPIC_API_KEY)" : "sk-…"}
            />
            <span className="mt-1 block text-[11px] text-gray-400">Stored only on this computer, in your home folder; never in the project.</span>
          </label>
          {provider === "anthropic" && (
            <label className="flex items-start gap-2 text-[12px] text-gray-600">
              <input type="checkbox" checked={fallbacks} onChange={(e) => setFallbacks(e.target.checked)} className="mt-0.5" />
              <span>If the model declines a request, let Anthropic retry it on a fallback model.</span>
            </label>
          )}
        </div>

        <div className="mt-4 space-y-2">
          {busy && <Busy>{busy}</Busy>}
          {error && <ErrorNote message={error} onClose={() => setError(null)} />}
          {ok && (
            <div className="flex items-center gap-1.5 rounded-md bg-emerald-50 px-3 py-2 text-[12px] text-emerald-700">
              <Check size={13} /> {ok}
            </div>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <button
            disabled={!!busy || !model.trim()}
            className={secondaryBtn}
            onClick={() =>
              act("Saving and asking the model to answer…", async () => {
                await save();
                const r = await api<{ reply: string }>("/_meld/agent/test");
                setOk(`The model answered: "${r.reply}"`);
              })
            }
          >
            Save and test
          </button>
          <button
            disabled={!!busy || !model.trim()}
            className={primaryBtn}
            onClick={() =>
              act("Saving…", async () => {
                await save();
                close();
              })
            }
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
