import { Play, RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { Trace } from "../engine";
import { METHOD_COLORS, sampleBody, statusColor } from "./util";
import type { AppView, FlowView } from "./view";

// "Try it": send a real request to the running app, then light up the path
// it took. Recent runs of the flow can be picked to replay on the canvas.

const TOKEN_KEY = "meld-studio:authorization";

function storedHeader(name: string): string {
  try {
    return localStorage.getItem(`${TOKEN_KEY}:${name}`) ?? "";
  } catch {
    return "";
  }
}

function storeHeader(name: string, value: string) {
  try {
    localStorage.setItem(`${TOKEN_KEY}:${name}`, value);
  } catch {
    // private window: just don't remember it
  }
}

export function RunPanel({ view, flow, trace, setTrace }: { view: AppView; flow: FlowView; trace?: Trace; setTrace: (t?: Trace) => void }) {
  const pathParams = [...flow.path.matchAll(/:([A-Za-z0-9_]+)/g)].map((m) => m[1]!);
  const headers = flow.inputs.filter((i) => i.header);
  const queryInputs = flow.method === "GET" || flow.method === "DELETE" ? flow.inputs.filter((i) => !i.header && !pathParams.includes(i.name)) : [];
  const hasBody = flow.method !== "GET" && flow.method !== "DELETE";

  const [params, setParams] = useState<Record<string, string>>({});
  const [query, setQuery] = useState<Record<string, string>>({});
  const [headerValues, setHeaderValues] = useState<Record<string, string>>(() => Object.fromEntries(headers.map((h) => [h.header!, storedHeader(h.header!)])));
  const [body, setBody] = useState(() => JSON.stringify(sampleBody(view, flow), null, 2));
  const [result, setResult] = useState<{ status: number; text: string; token?: string } | null>(null);
  const [runs, setRuns] = useState<Trace[]>([]);
  const [busy, setBusy] = useState(false);

  const loadRuns = useCallback(async () => {
    const all = (await (await fetch("/_meld/traces")).json()) as Trace[];
    const mine = all.filter((t) => t.flow === flow.key);
    setRuns(mine);
    return mine;
  }, [flow.key]);

  useEffect(() => {
    loadRuns();
  }, [loadRuns]);

  const send = async () => {
    setBusy(true);
    try {
      let path = flow.path;
      for (const p of pathParams) path = path.replace(`:${p}`, encodeURIComponent(params[p] ?? ""));
      const qs = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== ""));
      const h: Record<string, string> = { "content-type": "application/json" };
      for (const [name, value] of Object.entries(headerValues)) {
        if (value) h[name] = value;
        storeHeader(name, value);
      }
      const res = await fetch(`${path}${qs.size ? `?${qs}` : ""}`, { method: flow.method, headers: h, ...(hasBody ? { body } : {}) });
      const text = await res.text();
      let pretty = text;
      let token: string | undefined;
      try {
        const json = JSON.parse(text);
        pretty = JSON.stringify(json, null, 2);
        token = json?.user?.token;
      } catch {
        // not JSON
      }
      setResult({ status: res.status, text: pretty || "(empty)", token });
      const mine = await loadRuns();
      setTrace(mine[0]);
    } finally {
      setBusy(false);
    }
  };

  const input = "w-full rounded border border-gray-200 bg-white px-2 py-1 text-[12px] outline-none focus:border-blue-400";

  return (
    <div className="flex h-full gap-4 overflow-hidden p-4 text-[12px]">
      <div className="flex w-[360px] flex-none flex-col gap-2 overflow-auto">
        <div className="flex items-center gap-2">
          <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[flow.method] ?? ""}`}>{flow.method}</span>
          <span className="meld-code truncate text-gray-600">{flow.path}</span>
        </div>
        {pathParams.map((p) => (
          <label key={p} className="block">
            <span className="text-gray-500">{p}</span>
            <input className={input} value={params[p] ?? ""} onChange={(e) => setParams({ ...params, [p]: e.target.value })} />
          </label>
        ))}
        {queryInputs.map((q) => (
          <label key={q.name} className="block">
            <span className="text-gray-500">
              {q.name}
              {q.optional ? "?" : ""} <span className="text-gray-400">({q.type})</span>
            </span>
            <input className={input} value={query[q.name] ?? ""} onChange={(e) => setQuery({ ...query, [q.name]: e.target.value })} />
          </label>
        ))}
        {headers.map((h) => (
          <label key={h.name} className="block">
            <span className="text-gray-500">header {h.header}</span>
            <input className={`${input} meld-code`} placeholder="Token ..." value={headerValues[h.header!] ?? ""} onChange={(e) => setHeaderValues({ ...headerValues, [h.header!]: e.target.value })} />
          </label>
        ))}
        {hasBody && (
          <label className="block">
            <span className="text-gray-500">body</span>
            <textarea className={`${input} meld-code h-32`} value={body} onChange={(e) => setBody(e.target.value)} />
          </label>
        )}
        <button disabled={busy} onClick={send} className="flex items-center justify-center gap-1.5 rounded-md bg-blue-600 px-3 py-1.5 font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
          <Play size={13} /> Send
        </button>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-hidden">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Response</div>
        {!result && <div className="text-gray-400">Send a request to see the response and the path it took.</div>}
        {result && (
          <>
            <div className="flex items-center gap-2">
              <span className="rounded px-2 py-0.5 font-bold text-white" style={{ background: statusColor(result.status) }}>
                {result.status}
              </span>
              {result.token && headers.length > 0 && (
                <button
                  className="rounded border border-blue-200 px-2 py-0.5 text-blue-700 hover:bg-blue-50"
                  onClick={() => {
                    for (const h of headers) {
                      storeHeader(h.header!, `Token ${result.token}`);
                      setHeaderValues((v) => ({ ...v, [h.header!]: `Token ${result.token}` }));
                    }
                  }}
                >
                  Use this token for other requests
                </button>
              )}
              {result.token && headers.length === 0 && (
                <button className="rounded border border-blue-200 px-2 py-0.5 text-blue-700 hover:bg-blue-50" onClick={() => storeHeader("Authorization", `Token ${result.token}`)}>
                  Remember this token
                </button>
              )}
            </div>
            <pre className="meld-code min-h-0 flex-1 overflow-auto rounded-md bg-gray-50 p-2 text-[11px] text-gray-700">{result.text}</pre>
          </>
        )}
      </div>

      <div className="flex w-[260px] flex-none flex-col overflow-hidden">
        <div className="flex items-center justify-between">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Recent runs</div>
          <button onClick={loadRuns} className="rounded p-1 text-gray-400 hover:bg-gray-100" title="Refresh">
            <RefreshCw size={12} />
          </button>
        </div>
        <div className="mt-1 flex-1 overflow-auto">
          {runs.length === 0 && <div className="text-gray-400">No runs yet.</div>}
          {runs.map((t) => (
            <button
              key={t.id}
              onClick={() => setTrace(trace?.id === t.id ? undefined : t)}
              className={`mb-1 flex w-full items-center gap-2 rounded px-2 py-1 text-left ${trace?.id === t.id ? "bg-blue-50 ring-1 ring-blue-200" : "hover:bg-gray-50"}`}
            >
              <span className="w-9 rounded text-center text-[11px] font-bold text-white" style={{ background: statusColor(t.status) }}>
                {t.status}
              </span>
              <span className="flex-1 truncate text-gray-600">{new Date(t.startedAt).toLocaleTimeString()}</span>
              <span className="text-gray-400">{t.ms} ms</span>
            </button>
          ))}
        </div>
        {trace && (
          <button onClick={() => setTrace(undefined)} className="mt-1 rounded border border-gray-200 px-2 py-1 text-gray-600 hover:bg-gray-50">
            Hide run on canvas
          </button>
        )}
      </div>
    </div>
  );
}
