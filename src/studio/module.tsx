import { Boxes, Code2, Database, FunctionSquare, Globe, Workflow } from "lucide-react";
import type { ReactNode } from "react";
import { Category, IconBox } from "./flow";
import { colorFor, fieldLabel, METHOD_COLORS, PORT_HELP } from "./util";
import type { AppView, ModuleView } from "./view";

// One module, everything it owns: endpoints, steps, tables and helpers, plus
// who it depends on and who depends on it.

function Section({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <section className="mt-8">
      <h2 className="mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-gray-500">
        {icon}
        {title}
      </h2>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">{children}</div>
    </section>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function PortBadge({ port }: { port: string }) {
  return (
    <span title={PORT_HELP[port]} className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-semibold text-indigo-700">
      {port}
    </span>
  );
}

export function ModulePage({
  view,
  module: m,
  openFlow,
  openStep,
  openModule,
}: {
  view: AppView;
  module: ModuleView;
  openFlow: (key: string) => void;
  openStep: (key: string) => void;
  openModule: (name: string) => void;
}) {
  const color = colorFor(m.name);
  const dependsOn = view.links.filter((l) => l.from === m.name);
  const usedBy = view.links.filter((l) => l.to === m.name);
  return (
    <div className="h-full overflow-auto px-8 py-6">
      <div className="flex items-center gap-4">
        <IconBox color={color} size={48}>
          <Boxes size={22} />
        </IconBox>
        <div>
          <Category>Module</Category>
          <h1 className="text-[24px] font-semibold text-gray-800">{m.title ?? m.name}</h1>
          <div className="meld-code text-[12px] text-gray-500">{m.name}</div>
        </div>
      </div>

      <div className="mt-5 flex flex-wrap gap-6 text-[13px]">
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Depends on</div>
          {dependsOn.length === 0 && <span className="text-gray-400">nothing else</span>}
          {dependsOn.map((l) => (
            <button key={l.to} onClick={() => openModule(l.to)} className="mr-2 mb-1 rounded-md bg-white px-2 py-1 text-left shadow-sm hover:text-blue-600">
              <span className="font-semibold">{l.to}</span> <span className="text-gray-500">({l.steps.join(", ")})</span>
            </button>
          ))}
        </div>
        <div>
          <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">Used by</div>
          {usedBy.length === 0 && <span className="text-gray-400">no other module</span>}
          {usedBy.map((l) => (
            <button key={l.from} onClick={() => openModule(l.from)} className="mr-2 mb-1 rounded-md bg-white px-2 py-1 text-left shadow-sm hover:text-blue-600">
              <span className="font-semibold">{l.from}</span> <span className="text-gray-500">({l.steps.join(", ")})</span>
            </button>
          ))}
        </div>
      </div>

      <Section icon={<Globe size={13} />} title={`Endpoints (${m.flows.length})`}>
        {m.flows.map((f) => (
          <button key={f.key} onClick={() => openFlow(f.key)} className="meld-card p-4 text-left">
            <div className="flex items-center gap-2">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[f.method] ?? ""}`}>{f.method}</span>
              <span className="meld-code truncate text-[12px] text-gray-600">{f.path}</span>
            </div>
            <div className="mt-2 text-[15px] font-semibold text-gray-800">{f.title ?? f.name}</div>
            <div className="mt-1 text-[12px] text-gray-500">
              {plural(f.nodes.filter((n) => n.kind === "do").length, "step")} · {plural(f.nodes.filter((n) => n.kind === "respond").length, "possible response")}
            </div>
          </button>
        ))}
      </Section>

      <Section icon={<Workflow size={13} />} title={`Steps (${m.steps.length})`}>
        {m.steps.map((s) => (
          <button key={s.key} onClick={() => openStep(s.key)} className="meld-card p-4 text-left">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-[15px] font-semibold text-gray-800">{s.title ?? s.name}</div>
                <div className="meld-code text-[11px] text-gray-500">{s.key}</div>
              </div>
              {s.lang === "js" && (
                <span className="flex items-center gap-1 rounded bg-yellow-50 px-1.5 py-0.5 text-[10px] font-semibold text-yellow-700">
                  <Code2 size={11} /> JS
                </span>
              )}
            </div>
            <div className="mt-2 text-[12px] text-gray-600">
              <span className="text-gray-400">takes </span>
              {s.inputs.map((i) => i.name).join(", ") || "nothing"}
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {s.outcomes.map((o) => (
                <span key={o.name} className="rounded-full border border-emerald-200 px-2 py-0.5 text-[11px] text-emerald-700">
                  {o.name}
                </span>
              ))}
            </div>
            <div className="mt-2 flex items-center justify-between">
              <div className="flex gap-1">
                {s.ports.map((p) => (
                  <PortBadge key={p} port={p} />
                ))}
              </div>
              <span className="text-[11px] text-gray-500">
                used in {s.usedBy.length} {s.usedBy.length === 1 ? "place" : "places"}
              </span>
            </div>
          </button>
        ))}
      </Section>

      {m.tables.length > 0 && (
        <Section icon={<Database size={13} />} title={`Tables (${m.tables.length})`}>
          {m.tables.map((t) => (
            <div key={t.name} className="meld-card p-4">
              <div className="text-[15px] font-semibold text-gray-800">{t.name}</div>
              <div className="mt-2 text-[12px]">
                <div className="flex justify-between border-b border-gray-50 py-1">
                  <span className="meld-code text-gray-700">id</span>
                  <span className="text-gray-400">number · automatic</span>
                </div>
                {t.fields.map((f) => (
                  <div key={f.name} className="flex justify-between border-b border-gray-50 py-1">
                    <span className="meld-code text-gray-700">{f.name}</span>
                    <span className="text-gray-500">
                      {f.type}
                      {f.unique && <span className="ml-1 rounded bg-amber-50 px-1 text-[10px] font-semibold text-amber-700">unique</span>}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] text-gray-400">Only steps in {m.name} can read or change it.</div>
            </div>
          ))}
        </Section>
      )}

      {m.fns.length > 0 && (
        <Section icon={<FunctionSquare size={13} />} title={`Helpers (${m.fns.length})`}>
          {m.fns.map((f) => (
            <div key={f.name} className="meld-card p-4">
              <div className="meld-code text-[13px] font-semibold text-gray-800">{f.name}</div>
              <div className="meld-code mt-1 text-[11px] text-gray-500">
                ({f.params.map(fieldLabel).join(", ")}) → {f.returns}
              </div>
              <pre className="meld-code mt-2 max-h-48 overflow-auto rounded bg-gray-50 p-2 text-[11px] text-gray-600">{f.source.code}</pre>
            </div>
          ))}
        </Section>
      )}
      <div className="h-10" />
    </div>
  );
}
