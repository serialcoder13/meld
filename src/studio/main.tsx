import { ChevronRight, FlaskConical, LayoutGrid, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Trace } from "../engine";
import { FlowCanvas } from "./flow";
import { SystemMap } from "./map";
import { ModulePage } from "./module";
import { PiecePanel } from "./piece";
import { RunPanel } from "./run";
import { colorFor, findFlow, findModule, METHOD_COLORS } from "./util";
import type { AppView } from "./view";

type Route = { page: "map" } | { page: "module"; name: string } | { page: "flow"; key: string };
type Selection = { kind: "step"; key: string } | { kind: "node"; flow: string; node: string };

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "m" && id) return { page: "module", name: decodeURIComponent(id) };
  if (kind === "f" && id) return { page: "flow", key: decodeURIComponent(id) };
  return { page: "map" };
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    location.hash = r.page === "map" ? "/" : r.page === "module" ? `/m/${encodeURIComponent(r.name)}` : `/f/${encodeURIComponent(r.key)}`;
  }, []);
  return [route, go];
}

function Sidebar({ view, route, go, select }: { view: AppView; route: Route; go: (r: Route) => void; select: (s: Selection) => void }) {
  const [q, setQ] = useState("");
  const activeModule = route.page === "module" ? route.name : route.page === "flow" ? findFlow(view, route.key)?.module : undefined;
  const query = q.trim().toLowerCase();
  const hits = useMemo(() => {
    if (!query) return [];
    const out: { label: string; sub: string; onClick: () => void }[] = [];
    for (const m of view.modules) {
      for (const f of m.flows) {
        if (`${f.title} ${f.path} ${f.key}`.toLowerCase().includes(query)) out.push({ label: f.title ?? f.name, sub: `${f.method} ${f.path}`, onClick: () => go({ page: "flow", key: f.key }) });
      }
      for (const s of m.steps) {
        if (`${s.title} ${s.key}`.toLowerCase().includes(query)) out.push({ label: s.title ?? s.name, sub: s.key, onClick: () => select({ kind: "step", key: s.key }) });
      }
    }
    return out;
  }, [query, view, go, select]);

  const item = "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-gray-100";
  return (
    <nav className="flex h-full w-[260px] flex-none flex-col border-r border-gray-200 bg-white">
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5">
          <Search size={13} className="text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an endpoint or step" className="w-full text-[12px] outline-none" />
        </div>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-4">
        {query ? (
          <>
            {hits.length === 0 && <div className="px-2 text-[12px] text-gray-400">Nothing matches.</div>}
            {hits.map((h, i) => (
              <button key={i} onClick={h.onClick} className={item}>
                <div className="min-w-0">
                  <div className="truncate">{h.label}</div>
                  <div className="meld-code truncate text-[10px] text-gray-400">{h.sub}</div>
                </div>
              </button>
            ))}
          </>
        ) : (
          <>
            <button onClick={() => go({ page: "map" })} className={`${item} ${route.page === "map" ? "bg-blue-50 text-blue-700" : ""}`}>
              <LayoutGrid size={14} /> App map
            </button>
            <div className="mt-3 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Modules</div>
            {view.modules.map((m) => (
              <div key={m.name}>
                <button onClick={() => go({ page: "module", name: m.name })} className={`${item} ${route.page === "module" && route.name === m.name ? "bg-blue-50 text-blue-700" : ""}`}>
                  <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: colorFor(m.name) }} />
                  <span className="flex-1 truncate font-medium">{m.title ?? m.name}</span>
                  <span className="text-[11px] text-gray-400">{m.flows.length}</span>
                </button>
                {activeModule === m.name &&
                  m.flows.map((f) => (
                    <button
                      key={f.key}
                      onClick={() => go({ page: "flow", key: f.key })}
                      className={`${item} pl-6 ${route.page === "flow" && route.key === f.key ? "bg-blue-50 text-blue-700" : "text-gray-600"}`}
                    >
                      <span className={`w-[42px] flex-none rounded px-1 text-center text-[9px] font-bold ${METHOD_COLORS[f.method] ?? ""}`}>{f.method}</span>
                      <span className="truncate text-[12px]">{f.title ?? f.name}</span>
                    </button>
                  ))}
              </div>
            ))}
          </>
        )}
      </div>
    </nav>
  );
}

function App() {
  const [view, setView] = useState<AppView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, go] = useRoute();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trace, setTrace] = useState<Trace | undefined>();
  const [tryOpen, setTryOpen] = useState(false);

  const load = useCallback(() => {
    fetch("/_meld/view")
      .then((r) => r.json())
      .then((v: AppView) => {
        setView(v);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);
  useEffect(load, [load]);

  // a new page starts without a highlighted run
  useEffect(() => setTrace(undefined), [route]);

  if (error) return <div className="p-8 text-rose-600">Couldn't load the app model: {error}</div>;
  if (!view) return <div className="p-8 text-gray-500">Loading…</div>;

  const flow = route.page === "flow" ? findFlow(view, route.key) : undefined;
  const module = route.page === "module" ? findModule(view, route.name) : flow ? findModule(view, flow.module) : undefined;
  const selectedNode = selection?.kind === "node" && flow && selection.flow === flow.key ? selection.node : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 flex-none items-center gap-3 border-b border-gray-200 bg-white px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 text-[13px] font-bold text-white">M</div>
        <div className="text-[14px] font-semibold text-gray-800">Meld Studio</div>
        <div className="flex items-center gap-1 text-[13px] text-gray-500">
          <ChevronRight size={14} />
          <button onClick={() => go({ page: "map" })} className="hover:text-blue-600">
            {view.app.title ?? view.app.name}
          </button>
          {module && (
            <>
              <ChevronRight size={14} />
              <button onClick={() => go({ page: "module", name: module.name })} className="hover:text-blue-600">
                {module.title ?? module.name}
              </button>
            </>
          )}
          {flow && (
            <>
              <ChevronRight size={14} />
              <span className="text-gray-800">{flow.title ?? flow.name}</span>
            </>
          )}
        </div>
        <div className="flex-1" />
        {flow && (
          <button
            onClick={() => setTryOpen(!tryOpen)}
            className={`flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold ${tryOpen ? "bg-blue-600 text-white" : "border border-gray-200 text-gray-700 hover:bg-gray-50"}`}
          >
            <FlaskConical size={13} /> Try it
          </button>
        )}
        <button onClick={load} className="rounded p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Reload the model">
          <RefreshCw size={14} />
        </button>
      </header>
      <div className="flex min-h-0 flex-1">
        <Sidebar view={view} route={route} go={go} select={setSelection} />
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1">
            {route.page === "map" && <SystemMap view={view} open={(name) => go({ page: "module", name })} />}
            {route.page === "module" && module && (
              <ModulePage
                view={view}
                module={module}
                openFlow={(key) => go({ page: "flow", key })}
                openStep={(key) => setSelection({ kind: "step", key })}
                openModule={(name) => go({ page: "module", name })}
              />
            )}
            {flow && <FlowCanvas view={view} flow={flow} trace={trace} selected={selectedNode} select={(node) => setSelection({ kind: "node", flow: flow.key, node })} />}
            {route.page !== "map" && !module && !flow && <div className="p-8 text-gray-500">Not found.</div>}
          </div>
          {flow && tryOpen && (
            <div className="h-[300px] flex-none border-t border-gray-200 bg-white">
              <RunPanel key={flow.key} view={view} flow={flow} trace={trace} setTrace={setTrace} />
            </div>
          )}
        </main>
        {selection && (
          <PiecePanel
            view={view}
            selection={selection}
            close={() => setSelection(null)}
            openFlowAt={(flowKey, node) => {
              go({ page: "flow", key: flowKey });
              setSelection({ kind: "node", flow: flowKey, node });
            }}
          />
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
