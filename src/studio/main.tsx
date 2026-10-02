import { ChevronDown, ChevronRight, Database, FlaskConical, Globe, LayoutGrid, RefreshCw, Search, Settings, Workflow } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { Trace } from "../engine";
import { FlowCanvas } from "./flow";
import { SystemMap } from "./map";
import { ModulePage } from "./module";
import { PiecePanel, type Selection } from "./piece";
import { PieceView } from "./pieceview";
import { RunPanel } from "./run";
import { SettingsDialog, useAgentStatus } from "./settings";
import { colorFor, findFlow, findModule, findStep, METHOD_COLORS, statusColor } from "./util";
import type { AppView, FlowView, ModuleView } from "./view";

type Route = { page: "map" } | { page: "module"; name: string } | { page: "flow"; key: string } | { page: "piece"; key: string };

function parseRoute(hash: string): Route {
  const [, kind, id] = hash.replace(/^#/, "").split("/");
  if (kind === "m" && id) return { page: "module", name: decodeURIComponent(id) };
  if (kind === "f" && id) return { page: "flow", key: decodeURIComponent(id) };
  if (kind === "p" && id) return { page: "piece", key: decodeURIComponent(id) };
  return { page: "map" };
}

function routeHash(r: Route): string {
  if (r.page === "map") return "/";
  if (r.page === "module") return `/m/${encodeURIComponent(r.name)}`;
  return `/${r.page === "flow" ? "f" : "p"}/${encodeURIComponent(r.key)}`;
}

function useRoute(): [Route, (r: Route) => void] {
  const [route, setRoute] = useState(() => parseRoute(location.hash));
  useEffect(() => {
    const on = () => setRoute(parseRoute(location.hash));
    addEventListener("hashchange", on);
    return () => removeEventListener("hashchange", on);
  }, []);
  const go = useCallback((r: Route) => {
    location.hash = routeHash(r);
  }, []);
  return [route, go];
}

// A selection belongs to one view; when the view changes, it goes away.
function keepSelection(sel: Selection | null, route: Route): Selection | null {
  if (!sel) return null;
  if (sel.kind === "node" && route.page === "flow" && sel.flow === route.key) return sel;
  if (sel.kind === "step" && route.page === "piece" && sel.key === route.key) return sel;
  return null;
}

// ---- the tree on the left ----

function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const i = text.toLowerCase().indexOf(query);
  if (i < 0) return <>{text}</>;
  return (
    <>
      {text.slice(0, i)}
      <mark className="rounded-sm bg-yellow-200 px-0.5">{text.slice(i, i + query.length)}</mark>
      {text.slice(i + query.length)}
    </>
  );
}

function flowTables(view: AppView, f: FlowView): string[] {
  const out = new Set<string>();
  for (const n of f.nodes) {
    const s = n.step ? findStep(view, n.step) : undefined;
    for (const t of s?.tables ?? []) out.add(`${s!.module}.${t}`);
  }
  return [...out];
}

function Tree({ view, route, go, select, query }: { view: AppView; route: Route; go: (r: Route) => void; select: (s: Selection) => void; query: string }) {
  const activeModule =
    route.page === "module" ? route.name : route.page === "flow" ? findFlow(view, route.key)?.module : route.page === "piece" ? findStep(view, route.key)?.module : undefined;
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (k: string) => setOpen((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : new Set([...s, k])));
  const q = query.trim().toLowerCase();
  const hit = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q));

  const row = "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[12.5px] hover:bg-gray-100";
  const chevron = (k: string, show: boolean) => (
    <span
      onClick={(e) => {
        e.stopPropagation();
        toggle(k);
      }}
      className="flex h-4 w-4 flex-none items-center justify-center rounded text-gray-400 hover:bg-gray-200"
    >
      {show ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
    </span>
  );

  const endpoint = (m: ModuleView, f: FlowView) => {
    const steps = f.nodes.filter((n) => n.kind === "do").map((n) => ({ node: n, step: findStep(view, n.step!) }));
    const tables = flowTables(view, f);
    const responses = f.nodes.filter((n) => n.kind === "respond");
    const stepHits = steps.filter((s) => hit(s.step?.title, s.step?.key, s.node.id));
    const tableHits = tables.filter((t) => hit(t));
    const selfHit = hit(f.title, f.name, f.path, f.method);
    if (q && !selfHit && !stepHits.length && !tableHits.length) return null;
    const k = `f:${f.key}`;
    const expanded = open.has(k) || (!!q && (stepHits.length > 0 || tableHits.length > 0));
    const active = route.page === "flow" && route.key === f.key;
    return (
      <div key={f.key}>
        <button onClick={() => go({ page: "flow", key: f.key })} className={`${row} pl-5 ${active ? "bg-blue-50 text-blue-700" : "text-gray-700"}`}>
          {chevron(k, expanded)}
          <span className={`w-[40px] flex-none rounded px-1 text-center text-[9px] font-bold ${METHOD_COLORS[f.method] ?? ""}`}>{f.method}</span>
          <span className="truncate">
            <Highlight text={f.title ?? f.name} query={q} />
          </span>
        </button>
        {expanded && (
          <div className="mb-1 ml-[46px] border-l border-gray-100 pl-2">
            {(q ? stepHits : steps).map(({ node, step }) => (
              <button
                key={node.id}
                onClick={() => {
                  go({ page: "flow", key: f.key });
                  select({ kind: "node", flow: f.key, node: node.id });
                }}
                className={`${row} pl-1 text-gray-600`}
                title={step?.key}
              >
                <Workflow size={11} className="flex-none" style={{ color: colorFor(step?.module ?? "") }} />
                <span className="truncate">
                  <Highlight text={step?.title ?? node.id} query={q} />
                </span>
              </button>
            ))}
            {(q ? tableHits : tables).map((t) => (
              <button key={t} onClick={() => go({ page: "module", name: t.split(".")[0]! })} className={`${row} pl-1 text-gray-500`}>
                <Database size={11} className="flex-none" />
                <span className="truncate">
                  <Highlight text={`${t.split(".")[1]} table`} query={q} />
                </span>
              </button>
            ))}
            {!q && (
              <div className="flex flex-wrap gap-1 py-1 pl-1">
                {responses.map((r) => (
                  <span key={r.id} className="rounded px-1 text-[9px] font-bold text-white" style={{ background: statusColor(r.status!) }}>
                    {r.status}
                  </span>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    );
  };

  const modules = view.modules.map((m) => {
    const flows = m.flows.map((f) => endpoint(m, f)).filter(Boolean);
    const steps = m.steps.filter((s) => hit(s.title, s.key));
    const tables = m.tables.filter((t) => hit(t.name));
    const selfHit = hit(m.title, m.name);
    if (q && !selfHit && !flows.length && !steps.length && !tables.length) return null;
    const k = `m:${m.name}`;
    const expanded = q ? true : open.has(k) || activeModule === m.name;
    const section = (title: string, children: ReactNode) => (
      <>
        <div className="mt-1 pl-6 text-[10px] font-semibold uppercase tracking-wide text-gray-400">{title}</div>
        {children}
      </>
    );
    return (
      <div key={m.name}>
        <button onClick={() => go({ page: "module", name: m.name })} className={`${row} pl-1 ${route.page === "module" && route.name === m.name ? "bg-blue-50 text-blue-700" : ""}`}>
          {chevron(k, expanded)}
          <span className="h-2.5 w-2.5 flex-none rounded-sm" style={{ background: colorFor(m.name) }} />
          <span className="flex-1 truncate font-medium">
            <Highlight text={m.title ?? m.name} query={q} />
          </span>
          <span className="text-[11px] text-gray-400">{m.flows.length}</span>
        </button>
        {expanded && (
          <div className="mb-2">
            {flows.length > 0 && section("Endpoints", flows)}
            {steps.length > 0 &&
              section(
                "Steps",
                steps.map((s) => (
                  <button
                    key={s.key}
                    onClick={() => go({ page: "piece", key: s.key })}
                    className={`${row} pl-7 ${route.page === "piece" && route.key === s.key ? "bg-blue-50 text-blue-700" : "text-gray-600"}`}
                  >
                    <Workflow size={11} className="flex-none" style={{ color: colorFor(m.name) }} />
                    <span className="truncate">
                      <Highlight text={s.title ?? s.name} query={q} />
                    </span>
                  </button>
                )),
              )}
            {tables.length > 0 &&
              section(
                "Tables",
                tables.map((t) => (
                  <button key={t.name} onClick={() => go({ page: "module", name: m.name })} className={`${row} pl-7 text-gray-600`}>
                    <Database size={11} className="flex-none text-gray-400" />
                    <span className="truncate">
                      <Highlight text={t.name} query={q} />
                    </span>
                  </button>
                )),
              )}
          </div>
        )}
      </div>
    );
  });

  const shown = modules.filter(Boolean);
  return (
    <>
      {shown}
      {q && shown.length === 0 && <div className="px-2 text-[12px] text-gray-400">Nothing matches "{query}".</div>}
    </>
  );
}

function Sidebar(props: { view: AppView; route: Route; go: (r: Route) => void; select: (s: Selection) => void }) {
  const [q, setQ] = useState("");
  return (
    <nav className="flex h-full w-[280px] flex-none flex-col border-r border-gray-200 bg-white">
      <div className="p-3">
        <div className="flex items-center gap-2 rounded-md border border-gray-200 px-2 py-1.5">
          <Search size={13} className="text-gray-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an endpoint, step or table" className="w-full text-[12px] outline-none" />
        </div>
      </div>
      <div className="flex-1 overflow-auto px-2 pb-4">
        {!q && (
          <button onClick={() => props.go({ page: "map" })} className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-gray-100 ${props.route.page === "map" ? "bg-blue-50 text-blue-700" : ""}`}>
            <LayoutGrid size={14} /> App map
          </button>
        )}
        <div className="mt-3 mb-1 px-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{q ? "Matches" : "Modules"}</div>
        <Tree {...props} query={q} />
      </div>
    </nav>
  );
}

// ---- the app ----

function App() {
  const [view, setView] = useState<AppView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [route, go] = useRoute();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [trace, setTrace] = useState<Trace | undefined>();
  const [tryOpen, setTryOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [agent, reloadAgent] = useAgentStatus();

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

  useEffect(() => {
    setSelection((s) => keepSelection(s, route));
    setTrace(undefined);
  }, [route]);

  const nav = useMemo(
    () => ({
      openFlowAt: (flow: string, node: string) => {
        go({ page: "flow", key: flow });
        setSelection({ kind: "node", flow, node });
      },
      openPiece: (step: string) => {
        go({ page: "piece", key: step });
        setSelection({ kind: "step", key: step });
      },
      changed: load,
    }),
    [go, load],
  );

  if (error) return <div className="p-8 text-rose-600">Couldn't load the app model: {error}</div>;
  if (!view) return <div className="p-8 text-gray-500">Loading…</div>;

  const flow = route.page === "flow" ? findFlow(view, route.key) : undefined;
  const piece = route.page === "piece" ? findStep(view, route.key) : undefined;
  const module = route.page === "module" ? findModule(view, route.name) : flow ? findModule(view, flow.module) : piece ? findModule(view, piece.module) : undefined;
  const selectedNode = selection?.kind === "node" && flow && selection.flow === flow.key ? selection.node : undefined;

  return (
    <div className="flex h-full flex-col">
      <header className="flex h-12 flex-none items-center gap-3 border-b border-gray-200 bg-white px-4">
        <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-blue-500 to-violet-500 text-[13px] font-bold text-white">M</div>
        <div className="text-[14px] font-semibold text-gray-800">Meld Studio</div>
        <div className="flex min-w-0 items-center gap-1 text-[13px] text-gray-500">
          <ChevronRight size={14} />
          <button onClick={() => go({ page: "map" })} className="hover:text-blue-600">
            {view.app.title ?? view.app.name}
          </button>
          {module && (
            <>
              <ChevronRight size={14} />
              <button onClick={() => go({ page: "module", name: module.name })} className="truncate hover:text-blue-600">
                {module.title ?? module.name}
              </button>
            </>
          )}
          {(flow ?? piece) && (
            <>
              <ChevronRight size={14} />
              <span className="flex items-center gap-1 truncate text-gray-800">
                {flow ? <Globe size={12} /> : <Workflow size={12} />}
                {flow ? (flow.title ?? flow.name) : (piece!.title ?? piece!.name)}
              </span>
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
        <button
          onClick={() => setSettingsOpen(true)}
          className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] ${agent?.configured ? "text-gray-500 hover:bg-gray-100" : "border border-amber-200 bg-amber-50 font-semibold text-amber-700"}`}
          title="AI agent settings"
        >
          <Settings size={14} /> {agent?.configured ? agent.model : "Set up AI"}
        </button>
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
                changed={load}
              />
            )}
            {flow && <FlowCanvas view={view} flow={flow} trace={trace} selected={selectedNode} select={(node) => setSelection({ kind: "node", flow: flow.key, node })} />}
            {piece && <PieceView view={view} step={piece} open={nav.openFlowAt} select={() => setSelection({ kind: "step", key: piece.key })} />}
            {route.page !== "map" && !module && !flow && !piece && <div className="p-8 text-gray-500">Not found. It may have been renamed or removed.</div>}
          </div>
          {flow && tryOpen && (
            <div className="h-[300px] flex-none border-t border-gray-200 bg-white">
              <RunPanel key={flow.key} view={view} flow={flow} trace={trace} setTrace={setTrace} />
            </div>
          )}
        </main>
        {selection && <PiecePanel view={view} selection={selection} close={() => setSelection(null)} nav={nav} />}
      </div>
      {settingsOpen && (
        <SettingsDialog
          status={agent}
          close={() => setSettingsOpen(false)}
          saved={() => {
            reloadAgent();
          }}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
