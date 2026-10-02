import { ArrowRight, Code2, Globe, Workflow, X } from "lucide-react";
import type { ReactNode } from "react";
import { Category, IconBox, STATUS_TEXT } from "./flow";
import { PortBadge } from "./module";
import { colorFor, fieldLabel, findFlow, findModule, METHOD_COLORS, PORT_HELP, statusColor } from "./util";
import type { AppView, FlowView, NodeView, Source, StepView } from "./view";

// The right-hand panel: everything about one piece, including where it sits
// in the whole app.

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{title}</div>
      {children}
    </div>
  );
}

const KEYWORDS = new Set(
  "step flow module uses table fn record let const if else for of while return when respond on true false null from header unique js export default async function await".split(" "),
);

export function Code({ source }: { source: Source }) {
  const lines = source.code.split("\n");
  return (
    <div>
      <div className="meld-code mb-1 text-[11px] text-gray-400">
        {source.file}:{source.line}
      </div>
      <pre className="meld-code max-h-[420px] overflow-auto rounded-md bg-slate-900 p-3 text-[11.5px] leading-[1.55] text-slate-200">
        {lines.map((l, i) => (
          <div key={i} className="flex">
            <span className="mr-3 w-8 flex-none text-right text-slate-500 select-none">{source.line + i}</span>
            <span dangerouslySetInnerHTML={{ __html: highlight(l) }} />
          </div>
        ))}
      </pre>
    </div>
  );
}

function highlight(line: string): string {
  const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const span = (color: string, s: string) => `<span style="color:${color}">${esc(s)}</span>`;
  let out = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i]!;
    if (c === "/" && line[i + 1] === "/") {
      out += span("#64748b", line.slice(i));
      break;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < line.length && line[j] !== c) j += line[j] === "\\" ? 2 : 1;
      out += span("#86efac", line.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i))?.[0];
    if (word) {
      out += KEYWORDS.has(word) ? span("#93c5fd", word) : esc(word);
      i += word.length;
      continue;
    }
    out += esc(c);
    i++;
  }
  return out;
}

function StepPanel({ view, step, openFlowAt }: { view: AppView; step: StepView; openFlowAt: (flow: string, node: string) => void }) {
  const tables = findModule(view, step.module)?.tables.map((t) => t.name) ?? [];
  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <Category>
          Step · {step.module} · {step.lang === "js" ? "JavaScript" : "Meld"}
        </Category>
        <div className="mt-2 flex items-center gap-3">
          <IconBox color={colorFor(step.module)}>{step.lang === "js" ? <Code2 size={17} /> : <Workflow size={17} />}</IconBox>
          <div>
            <div className="text-[18px] font-semibold text-gray-800">{step.title ?? step.name}</div>
            <div className="meld-code text-[12px] text-gray-500">{step.key}</div>
          </div>
        </div>
      </div>
      <Block title="Takes">
        {step.inputs.length === 0 && <div className="text-[13px] text-gray-400">nothing</div>}
        {step.inputs.map((i) => (
          <div key={i.name} className="meld-code py-0.5 text-[12px] text-gray-700">
            {fieldLabel(i)}
          </div>
        ))}
      </Block>
      <Block title="Ends with one of">
        {step.outcomes.map((o) => (
          <div key={o.name} className="flex items-baseline gap-2 py-0.5">
            <span className="h-2 w-2 flex-none rounded-full border-2 border-emerald-500" />
            <span className="text-[13px] font-semibold text-gray-800">{o.name}</span>
            <span className="meld-code truncate text-[11px] text-gray-500">{o.fields.map(fieldLabel).join(", ")}</span>
          </div>
        ))}
      </Block>
      <Block title="Touches">
        {step.ports.length === 0 && <div className="text-[13px] text-gray-500">Nothing outside itself: same inputs, same result.</div>}
        {step.ports.map((p) => (
          <div key={p} className="flex items-baseline gap-2 py-0.5 text-[13px]">
            <PortBadge port={p} />
            <span className="text-gray-600">
              {PORT_HELP[p]}
              {p === "db" && tables.length > 0 && <span className="text-gray-400"> ({tables.join(", ")})</span>}
            </span>
          </div>
        ))}
      </Block>
      <Block title={`Used in ${step.usedBy.length} ${step.usedBy.length === 1 ? "place" : "places"}`}>
        {step.usedBy.length === 0 && <div className="text-[13px] text-gray-400">No flow uses it yet.</div>}
        {step.usedBy.map((u) => {
          const flow = findFlow(view, u.flow);
          return (
            <button key={`${u.flow}.${u.node}`} onClick={() => openFlowAt(u.flow, u.node)} className="mb-2 block w-full rounded-md border border-gray-100 p-3 text-left hover:border-blue-200 hover:bg-blue-50/40">
              <div className="flex items-center gap-1.5">
                {flow && <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${METHOD_COLORS[flow.method] ?? ""}`}>{flow.method}</span>}
                <span className="meld-code truncate text-[11px] text-gray-500">{flow?.path}</span>
              </div>
              <div className="mt-1 text-[13px] font-semibold text-gray-800">
                {flow?.title ?? u.flow} <span className="font-normal text-gray-400">as '{u.node}'</span>
              </div>
              {u.after.length > 0 && <div className="mt-1 text-[11px] text-gray-500">runs after {u.after.join(", ")}</div>}
              <div className="mt-1 space-y-0.5">
                {u.next.map((n) => (
                  <div key={n.outcome} className="flex items-center gap-1 text-[11px] text-gray-600">
                    <span className="font-semibold text-emerald-700">{n.outcome}</span>
                    <ArrowRight size={11} className="text-gray-400" />
                    <span className="truncate">{n.targets.join(", ") || "nothing"}</span>
                  </div>
                ))}
              </div>
            </button>
          );
        })}
        <div className="mt-1 text-[12px] text-gray-500">
          Modules allowed to use it: <span className="font-semibold text-gray-700">{step.callers.join(", ")}</span>
        </div>
      </Block>
      <Block title="Code">
        <Code source={step.source} />
      </Block>
    </>
  );
}

function RespondPanel({ node }: { node: NodeView }) {
  const status = node.status!;
  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <Category>Response</Category>
        <div className="mt-2 flex items-center gap-3">
          <IconBox color={statusColor(status)}>
            <span className="text-[13px] font-bold">{status}</span>
          </IconBox>
          <div className="text-[18px] font-semibold text-gray-800">{STATUS_TEXT[status] ?? status}</div>
        </div>
      </div>
      <Block title="Sent when">
        {node.deps.length === 0 && <div className="text-[13px] text-gray-500">always</div>}
        {node.deps.map((d) => (
          <div key={`${d.node}.${d.outcome}`} className="text-[13px] text-gray-700">
            <span className="font-semibold">{d.node}</span> ends with <span className="font-semibold text-emerald-700">{d.outcome}</span>
          </div>
        ))}
      </Block>
      <Block title="Body">
        <pre className="meld-code rounded-md bg-gray-50 p-3 text-[12px] break-words whitespace-pre-wrap text-gray-700">{node.body ?? "(no body)"}</pre>
      </Block>
    </>
  );
}

function EndpointPanel({ flow }: { flow: FlowView }) {
  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <Category>Endpoint · {flow.module}</Category>
        <div className="mt-2 flex items-center gap-3">
          <IconBox color="#0EA5E9">
            <Globe size={17} />
          </IconBox>
          <div>
            <div className="text-[18px] font-semibold text-gray-800">{flow.title ?? flow.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[flow.method] ?? ""}`}>{flow.method}</span>
              <span className="meld-code text-[12px] text-gray-500">{flow.path}</span>
            </div>
          </div>
        </div>
      </div>
      <Block title="Request">
        {flow.inputs.map((i) => (
          <div key={i.name} className="meld-code py-0.5 text-[12px] text-gray-700">
            {fieldLabel(i)}
            {i.header && <span className="text-gray-400"> · from header {i.header}</span>}
          </div>
        ))}
      </Block>
      <Block title="Could answer with">
        {flow.nodes
          .filter((n) => n.kind === "respond")
          .map((n) => (
            <div key={n.id} className="flex items-center gap-2 py-0.5 text-[13px]">
              <span className="w-9 rounded text-center text-[11px] font-bold text-white" style={{ background: statusColor(n.status!) }}>
                {n.status}
              </span>
              <span className="text-gray-700">{STATUS_TEXT[n.status!]}</span>
              <span className="truncate text-[11px] text-gray-400">when {n.deps.map((d) => `${d.node}.${d.outcome}`).join(", ") || "always"}</span>
            </div>
          ))}
      </Block>
      <Block title="Code">
        <Code source={flow.source} />
      </Block>
    </>
  );
}

export function PiecePanel({
  view,
  selection,
  close,
  openFlowAt,
}: {
  view: AppView;
  selection: { kind: "step"; key: string } | { kind: "node"; flow: string; node: string };
  close: () => void;
  openFlowAt: (flow: string, node: string) => void;
}) {
  let content: ReactNode = null;
  if (selection.kind === "step") {
    const step = view.modules.flatMap((m) => m.steps).find((s) => s.key === selection.key);
    if (step) content = <StepPanel view={view} step={step} openFlowAt={openFlowAt} />;
  } else {
    const flow = findFlow(view, selection.flow);
    const node = flow?.nodes.find((n) => n.id === selection.node);
    if (flow && selection.node === "trigger") content = <EndpointPanel flow={flow} />;
    else if (node?.kind === "respond") content = <RespondPanel node={node} />;
    else if (node?.step) {
      const step = view.modules.flatMap((m) => m.steps).find((s) => s.key === node.step);
      if (step) content = <StepPanel view={view} step={step} openFlowAt={openFlowAt} />;
    }
  }
  return (
    <aside className="relative h-full w-[440px] flex-none overflow-auto border-l border-gray-200 bg-white">
      <button onClick={close} className="absolute top-3 right-3 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Close">
        <X size={16} />
      </button>
      {content}
    </aside>
  );
}
