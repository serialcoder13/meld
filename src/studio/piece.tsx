import { ArrowRight, Code2, Globe, Network, Workflow, X } from "lucide-react";
import type { ReactNode } from "react";
import { ChangeBox, EditableTitle, ExplanationEditor } from "./edit";
import { Category, IconBox, STATUS_TEXT } from "./flow";
import { PortBadge } from "./module";
import { colorFor, fieldLabel, findFlow, METHOD_COLORS, PORT_HELP, statusColor } from "./util";
import type { AppView, FlowView, NodeView, StepView } from "./view";

// The right-hand panel: everything about one piece, in plain language, and
// where it sits in the whole app. No code: people change the explanation or
// ask for a change, and the AI and Meld do the rest.

export function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="border-t border-gray-100 px-5 py-4">
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{title}</div>
      {children}
    </div>
  );
}

type Nav = {
  openFlowAt: (flow: string, node: string) => void;
  openPiece: (step: string) => void;
  changed: () => void;
};

function StepPanel({ view, step, nav }: { view: AppView; step: StepView; nav: Nav }) {
  const target = { kind: "step" as const, module: step.module, name: step.name };
  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <Category>
          Step · {step.module}
          {step.lang === "js" ? " · JavaScript" : ""}
        </Category>
        <div className="mt-2 flex items-center gap-3">
          <IconBox color={colorFor(step.module)}>{step.lang === "js" ? <Code2 size={17} /> : <Workflow size={17} />}</IconBox>
          <div className="min-w-0">
            <EditableTitle target={target} title={step.title ?? step.name} className="text-[18px] font-semibold text-gray-800" onChanged={nav.changed} />
            <div className="meld-code text-[12px] text-gray-500">{step.key}</div>
          </div>
        </div>
        <button onClick={() => nav.openPiece(step.key)} className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-200 px-2.5 py-1 text-[12px] font-semibold text-gray-700 hover:bg-gray-50">
          <Network size={13} /> See it in the whole app
        </button>
      </div>
      <Block title="What it does">
        <ExplanationEditor key={`${step.key}:${step.doc ?? ""}`} target={target} doc={step.doc} onChanged={nav.changed} />
      </Block>
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
              {p === "db" && step.tables.length ? `reads and writes the ${step.tables.join(", ")} ${step.tables.length === 1 ? "table" : "tables"}` : PORT_HELP[p]}
            </span>
          </div>
        ))}
      </Block>
      <Block title={`Used in ${step.usedBy.length} ${step.usedBy.length === 1 ? "place" : "places"}`}>
        {step.usedBy.length === 0 && <div className="text-[13px] text-gray-400">No endpoint uses it yet.</div>}
        {step.usedBy.map((u) => {
          const flow = findFlow(view, u.flow);
          return (
            <button key={`${u.flow}.${u.node}`} onClick={() => nav.openFlowAt(u.flow, u.node)} className="mb-2 block w-full rounded-md border border-gray-100 p-3 text-left hover:border-blue-200 hover:bg-blue-50/40">
              <div className="flex items-center gap-1.5">
                {flow && <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${METHOD_COLORS[flow.method] ?? ""}`}>{flow.method}</span>}
                <span className="meld-code truncate text-[11px] text-gray-500">{flow?.path}</span>
              </div>
              <div className="mt-1 text-[13px] font-semibold text-gray-800">{flow?.title ?? u.flow}</div>
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
      {step.lang === "meld" && (
        <Block title="Ask for a change">
          <ChangeBox key={step.key} target={target} onChanged={nav.changed} />
        </Block>
      )}
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
      <Block title="Sends back">
        <div className="meld-code rounded-md bg-gray-50 p-3 text-[12px] break-words whitespace-pre-wrap text-gray-700">{node.body ?? "nothing"}</div>
      </Block>
    </>
  );
}

function EndpointPanel({ flow, nav }: { flow: FlowView; nav: Nav }) {
  const target = { kind: "flow" as const, module: flow.module, name: flow.name };
  return (
    <>
      <div className="px-5 pt-5 pb-4">
        <Category>Endpoint · {flow.module}</Category>
        <div className="mt-2 flex items-center gap-3">
          <IconBox color="#0EA5E9">
            <Globe size={17} />
          </IconBox>
          <div>
            <EditableTitle target={target} title={flow.title ?? flow.name} className="text-[18px] font-semibold text-gray-800" onChanged={nav.changed} />
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[flow.method] ?? ""}`}>{flow.method}</span>
              <span className="meld-code text-[12px] text-gray-500">{flow.path}</span>
            </div>
          </div>
        </div>
      </div>
      <Block title="What it does">
        <ExplanationEditor key={`${flow.key}:${flow.doc ?? ""}`} target={target} doc={flow.doc} onChanged={nav.changed} />
      </Block>
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
      <Block title="Ask for a change">
        <ChangeBox key={flow.key} target={target} onChanged={nav.changed} />
      </Block>
    </>
  );
}

export type Selection = { kind: "step"; key: string } | { kind: "node"; flow: string; node: string };

export function PiecePanel({ view, selection, close, nav }: { view: AppView; selection: Selection; close: () => void; nav: Nav }) {
  const stepOf = (key: string) => view.modules.flatMap((m) => m.steps).find((s) => s.key === key);
  let content: ReactNode = null;
  if (selection.kind === "step") {
    const step = stepOf(selection.key);
    if (step) content = <StepPanel view={view} step={step} nav={nav} />;
  } else {
    const flow = findFlow(view, selection.flow);
    const node = flow?.nodes.find((n) => n.id === selection.node);
    if (flow && selection.node === "trigger") content = <EndpointPanel flow={flow} nav={nav} />;
    else if (node?.kind === "respond") content = <RespondPanel node={node} />;
    else if (node?.step) {
      const step = stepOf(node.step);
      if (step) content = <StepPanel view={view} step={step} nav={nav} />;
    }
  }
  return (
    <aside className="relative h-full w-[440px] flex-none overflow-auto border-l border-gray-200 bg-white">
      <button onClick={close} className="absolute top-3 right-3 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700" title="Close">
        <X size={16} />
      </button>
      {content ?? <div className="p-5 text-[13px] text-gray-400">This piece no longer exists.</div>}
    </aside>
  );
}
