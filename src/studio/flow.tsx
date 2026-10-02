import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesInitialized,
  useNodesState,
  useReactFlow,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Code2, Globe, Workflow } from "lucide-react";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { Trace, TraceNode } from "../engine";
import { colorFor, findStep, layout, METHOD_COLORS, statusColor } from "./util";
import type { AppView, FlowView, NodeView, StepView } from "./view";

// The flow canvas: the endpoint on the left, each step as a card whose
// outcomes are connectors, and the responses on the right. A selected run
// lights up the path it took.

export const STATUS_TEXT: Record<number, string> = {
  200: "OK",
  201: "Created",
  204: "No content",
  400: "Bad request",
  401: "Not signed in",
  402: "Payment required",
  403: "Not allowed",
  404: "Not found",
  409: "Conflict",
  422: "Invalid input",
  500: "Server error",
};

interface FlowCtx {
  view: AppView;
  trace?: Trace;
  selected?: string;
  select: (nodeId: string) => void;
}

const Ctx = createContext<FlowCtx | null>(null);
const useFlow = () => useContext(Ctx)!;

type StepData = { node: NodeView; step: StepView };
type RespondData = { node: NodeView };
type TriggerData = { flow: FlowView };

function runOf(trace: Trace | undefined, id: string): TraceNode | undefined {
  return trace?.nodes.find((n) => n.id === id);
}

function runClass(run: TraceNode | undefined, trace: Trace | undefined): string {
  if (!trace) return "";
  if (!run) return "run-skipped";
  return run.status === "done" ? "run-done" : run.status === "failed" ? "run-failed" : "run-skipped";
}

export function Label({ children }: { children: ReactNode }) {
  return <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-gray-400">{children}</div>;
}

export function Category({ children }: { children: ReactNode }) {
  return <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500">{children}</div>;
}

export function IconBox({ color, children, size = 35 }: { color: string; children: ReactNode; size?: number }) {
  return (
    <span className="flex flex-none items-center justify-center rounded-[10px] text-white" style={{ background: color, width: size, height: size }}>
      {children}
    </span>
  );
}

function StepNode({ id, data }: NodeProps<Node<StepData>>) {
  const { trace, selected, select } = useFlow();
  const { node, step } = data;
  const run = runOf(trace, id);
  return (
    <div className={`meld-card w-[310px] cursor-pointer ${selected === id ? "is-selected" : ""} ${runClass(run, trace)}`} onClick={() => select(id)}>
      <Handle type="target" position={Position.Left} id="in" className="meld-in" />
      <div className="meld-card-head px-3 py-2.5">
        <Category>
          {step.module}
          {step.lang === "js" ? " · JavaScript" : ""}
        </Category>
        <div className="mt-1 flex items-center gap-3">
          <IconBox color={colorFor(step.module)}>{step.lang === "js" ? <Code2 size={17} /> : <Workflow size={17} />}</IconBox>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight text-gray-800">{step.title ?? step.name}</div>
            <div className="meld-code truncate text-[11px] text-gray-500">
              {node.name} = {step.key}
            </div>
          </div>
        </div>
        {step.doc && <div className="mt-2 line-clamp-2 text-[11.5px] leading-snug text-gray-500">{step.doc.split("\n")[0]}</div>}
      </div>
      <div className="flex gap-4 px-4 pt-3 pb-3">
        <div className="min-w-0 flex-1">
          <Label>Inputs</Label>
          {node.args.length === 0 && <div className="text-[12px] text-gray-400">none</div>}
          {node.args.map((a) => (
            <div key={a.name} className="py-1">
              <div className="text-[12px] font-semibold text-gray-700">{a.name}</div>
              <div className="meld-code truncate rounded bg-gray-50 px-2 py-0.5 text-[11px] text-gray-500" title={a.value}>
                {a.value}
              </div>
            </div>
          ))}
        </div>
        <div className="flex-none text-right">
          <Label>Outcomes</Label>
          {step.outcomes.map((o) => {
            const taken = run?.outcome === o.name;
            return (
              <div key={o.name} className="relative py-1">
                <div className={`text-[13px] ${taken ? "font-semibold text-emerald-600" : "text-gray-700"}`}>{o.name}</div>
                {o.fields.length > 0 && <div className="text-[10px] text-gray-400">{o.fields.map((f) => f.name).join(", ")}</div>}
                <Handle type="source" position={Position.Right} id={o.name} className={`meld-out ${taken ? "is-taken" : ""}`} style={{ right: -16 }} />
              </div>
            );
          })}
        </div>
      </div>
      {run && run.status !== "skipped" && (
        <div className={`flex items-center justify-between rounded-b-md border-t px-3 py-1.5 text-[11px] ${run.status === "failed" ? "border-rose-100 bg-rose-50 text-rose-700" : "border-emerald-100 bg-emerald-50 text-emerald-700"}`}>
          <span className="font-semibold">{run.status === "failed" ? "failed" : `→ ${run.outcome}`}</span>
          <span>{run.ms} ms</span>
        </div>
      )}
    </div>
  );
}

function RespondNode({ id, data }: NodeProps<Node<RespondData>>) {
  const { trace, selected, select } = useFlow();
  const status = data.node.status!;
  const run = runOf(trace, id);
  return (
    <div className={`meld-card w-[240px] cursor-pointer ${selected === id ? "is-selected" : ""} ${runClass(run, trace)}`} onClick={() => select(id)}>
      <Handle type="target" position={Position.Left} id="in" className="meld-in" />
      <div className="meld-card-head flex items-center gap-3 px-3 py-2.5">
        <IconBox color={statusColor(status)}>
          <span className="text-[13px] font-bold">{status}</span>
        </IconBox>
        <div>
          <Category>Response</Category>
          <div className="text-[14px] font-semibold text-gray-800">{STATUS_TEXT[status] ?? status}</div>
        </div>
      </div>
      {data.node.body && <div className="meld-code px-3 py-2 text-[11px] break-words whitespace-pre-wrap text-gray-500">{data.node.body}</div>}
    </div>
  );
}

function TriggerNode({ data }: NodeProps<Node<TriggerData>>) {
  const { trace, selected, select } = useFlow();
  const f = data.flow;
  return (
    <div className={`meld-card w-[270px] cursor-pointer ${selected === "trigger" ? "is-selected" : ""} ${trace ? "run-done" : ""}`} onClick={() => select("trigger")}>
      <div className="meld-card-head px-3 py-2.5">
        <Category>Endpoint</Category>
        <div className="mt-1 flex items-center gap-3">
          <IconBox color="#0EA5E9">
            <Globe size={17} />
          </IconBox>
          <div className="min-w-0">
            <div className="text-[15px] font-semibold leading-tight text-gray-800">{f.title ?? f.name}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${METHOD_COLORS[f.method] ?? ""}`}>{f.method}</span>
              <span className="meld-code truncate text-[11px] text-gray-500">{f.path}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="px-4 pt-3 pb-3">
        <Label>Request</Label>
        {f.inputs.length === 0 && <div className="text-[12px] text-gray-400">nothing</div>}
        {f.inputs.map((i) => (
          <div key={i.name} className="flex items-baseline justify-between gap-2 py-0.5">
            <span className="text-[12px] font-semibold text-gray-700">
              {i.name}
              {i.optional ? <span className="text-gray-400">?</span> : null}
            </span>
            <span className="meld-code truncate text-[11px] text-gray-500">{i.header ? `header ${i.header}` : i.type}</span>
          </div>
        ))}
      </div>
      <Handle type="source" position={Position.Right} id="start" className="meld-out" />
    </div>
  );
}

const nodeTypes = { step: StepNode, respond: RespondNode, trigger: TriggerNode };

function buildGraph(view: AppView, flow: FlowView): { nodes: Node[]; edges: Edge[]; ports: Map<string, string[]> } {
  const nodes: Node[] = [{ id: "trigger", type: "trigger", position: { x: 0, y: 0 }, data: { flow } }];
  const ports = new Map<string, string[]>([["trigger", ["start"]]]);
  const edges: Edge[] = [];
  for (const n of flow.nodes) {
    if (n.kind === "do") {
      const step = findStep(view, n.step!)!;
      nodes.push({ id: n.id, type: "step", position: { x: 0, y: 0 }, data: { node: n, step } });
      ports.set(n.id, step.outcomes.map((o) => o.name));
    } else {
      nodes.push({ id: n.id, type: "respond", position: { x: 0, y: 0 }, data: { node: n } });
      ports.set(n.id, []);
    }
    for (const d of n.deps) {
      edges.push({ id: `${d.node}.${d.outcome}->${n.id}`, source: d.node, sourceHandle: d.outcome, target: n.id, targetHandle: "in" });
    }
    if (n.deps.length === 0) {
      edges.push({ id: `trigger->${n.id}`, source: "trigger", sourceHandle: "start", target: n.id, targetHandle: "in", className: "meld-input" });
    }
  }
  return { nodes, edges, ports };
}

function Canvas({ flow, trace }: { flow: FlowView; trace?: Trace }) {
  const { view } = useFlow();
  const graph = useMemo(() => buildGraph(view, flow), [view, flow]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const initialized = useNodesInitialized();
  const rf = useReactFlow();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!initialized || ready) return;
    const measured = rf.getNodes();
    layout(
      measured.map((n) => ({ id: n.id, width: n.measured?.width ?? 300, height: n.measured?.height ?? 150, outPorts: graph.ports.get(n.id) ?? [] })),
      graph.edges.map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourceHandle ?? undefined, target: e.target })),
    ).then((pos) => {
      setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
      setReady(true);
      requestAnimationFrame(() => rf.fitView({ padding: 0.12, duration: 250 }));
    });
  }, [initialized, ready, rf, graph, setNodes]);

  const edges = useMemo(() => {
    if (!trace) return graph.edges;
    return graph.edges.map((e) => {
      const from = runOf(trace, e.source);
      const to = runOf(trace, e.target);
      const taken = (e.source === "trigger" || (from?.status === "done" && from.outcome === e.sourceHandle)) && to && to.status !== "skipped";
      return { ...e, className: `${e.className ?? ""} ${taken ? "run-taken" : "run-not-taken"}`, animated: !!taken };
    });
  }, [graph, trace]);

  return (
    <div className="h-full w-full transition-opacity duration-200" style={{ opacity: ready ? 1 : 0 }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        nodesConnectable={false}
        minZoom={0.15}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="rgba(0,0,0,0.18)" />
        <MiniMap pannable zoomable className="!bg-white" style={{ width: 150, height: 96 }} nodeColor={(n) => (n.type === "step" ? colorFor((n.data as StepData).step.module) : n.type === "respond" ? statusColor((n.data as RespondData).node.status!) : "#0EA5E9")} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function FlowCanvas(props: { view: AppView; flow: FlowView; trace?: Trace; selected?: string; select: (id: string) => void }) {
  return (
    <Ctx.Provider value={{ view: props.view, trace: props.trace, selected: props.selected, select: props.select }}>
      <ReactFlowProvider key={props.flow.key}>
        <Canvas flow={props.flow} trace={props.trace} />
      </ReactFlowProvider>
    </Ctx.Provider>
  );
}
