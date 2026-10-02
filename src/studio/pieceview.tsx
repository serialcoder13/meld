import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
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
import { ArrowRight, Code2, Database, Globe, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Category, IconBox, Label } from "./flow";
import { colorFor, findFlow, layout, METHOD_COLORS } from "./util";
import type { AppView, StepView } from "./view";

// One piece and its whole neighbourhood: every endpoint that uses the step
// (left), what each of its outcomes leads to in each of them (right), and the
// data it touches (below). This is what someone who owns one piece reads to
// know what they can change safely.

type Usage = StepView["usedBy"][number];
type UsageData = { usage: Usage; view: AppView; open: (flow: string, node: string) => void };
type CenterData = { step: StepView; select: () => void };
type OutcomeData = { step: StepView; outcome: string; usages: Usage[]; view: AppView };
type TableData = { name: string; module: string };

function UsageNode({ data }: NodeProps<Node<UsageData>>) {
  const flow = findFlow(data.view, data.usage.flow);
  return (
    <div className="meld-card w-[270px] cursor-pointer" onClick={() => data.open(data.usage.flow, data.usage.node)}>
      <div className="meld-card-head px-3 py-2.5">
        <Category>Used by · {flow?.module}</Category>
        <div className="mt-1 flex items-center gap-3">
          <IconBox color="#0EA5E9" size={30}>
            <Globe size={15} />
          </IconBox>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold leading-tight text-gray-800">{flow?.title ?? data.usage.flow}</div>
            <div className="mt-0.5 flex items-center gap-1.5">
              <span className={`rounded px-1.5 py-0.5 text-[9px] font-bold ${METHOD_COLORS[flow?.method ?? ""] ?? ""}`}>{flow?.method}</span>
              <span className="meld-code truncate text-[10px] text-gray-500">{flow?.path}</span>
            </div>
          </div>
        </div>
      </div>
      <div className="px-3 pt-2 pb-3">
        <Label>Passes in</Label>
        {data.usage.args.map((a) => (
          <div key={a.name} className="flex items-baseline justify-between gap-2 py-0.5">
            <span className="text-[12px] font-semibold text-gray-700">{a.name}</span>
            <span className="meld-code truncate text-[10px] text-gray-500" title={a.value}>
              {a.value}
            </span>
          </div>
        ))}
        {data.usage.after.length > 0 && <div className="mt-1 text-[11px] text-gray-400">after {data.usage.after.join(", ")}</div>}
      </div>
      <Handle type="source" position={Position.Right} id="out" className="meld-out" />
    </div>
  );
}

function CenterNode({ data }: NodeProps<Node<CenterData>>) {
  const s = data.step;
  return (
    <div className="meld-card is-selected w-[320px] cursor-pointer" onClick={data.select}>
      <Handle type="target" position={Position.Left} id="in" className="meld-in" />
      <div className="meld-card-head px-3 py-2.5">
        <Category>This step · {s.module}</Category>
        <div className="mt-1 flex items-center gap-3">
          <IconBox color={colorFor(s.module)}>{s.lang === "js" ? <Code2 size={17} /> : <Workflow size={17} />}</IconBox>
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-tight text-gray-800">{s.title ?? s.name}</div>
            <div className="meld-code text-[11px] text-gray-500">{s.key}</div>
          </div>
        </div>
        {s.doc && <div className="mt-2 line-clamp-3 text-[12px] text-gray-600">{s.doc}</div>}
      </div>
      <div className="flex gap-4 px-4 pt-3 pb-3">
        <div className="min-w-0 flex-1">
          <Label>Takes</Label>
          {s.inputs.map((i) => (
            <div key={i.name} className="py-0.5 text-[12px] text-gray-700">
              <span className="font-semibold">{i.name}</span> <span className="meld-code text-[10px] text-gray-400">{i.type}</span>
            </div>
          ))}
        </div>
        <div className="flex-none text-right">
          <Label>Ends with</Label>
          {s.outcomes.map((o) => (
            <div key={o.name} className="relative py-1 text-[13px] text-gray-700">
              {o.name}
              <Handle type="source" position={Position.Right} id={o.name} className="meld-out" style={{ right: -16 }} />
            </div>
          ))}
        </div>
      </div>
      {s.tables.length > 0 && <Handle type="source" position={Position.Bottom} id="data" className="meld-out" />}
    </div>
  );
}

function OutcomeNode({ data }: NodeProps<Node<OutcomeData>>) {
  return (
    <div className="meld-card w-[300px]">
      <Handle type="target" position={Position.Left} id="in" className="meld-in" />
      <div className="meld-card-head px-3 py-2">
        <Category>When it ends with</Category>
        <div className="text-[15px] font-semibold text-emerald-700">{data.outcome}</div>
      </div>
      <div className="px-3 pt-2 pb-3">
        {data.usages.map((u) => {
          const next = u.next.find((n) => n.outcome === data.outcome)?.targets ?? [];
          return (
            <div key={`${u.flow}.${u.node}`} className="py-1">
              <div className="text-[11px] text-gray-400">in {findFlow(data.view, u.flow)?.title ?? u.flow}</div>
              <div className="flex items-center gap-1 text-[12px] text-gray-700">
                <ArrowRight size={11} className="flex-none text-gray-400" />
                <span className="truncate">{next.join(", ") || "nothing"}</span>
              </div>
            </div>
          );
        })}
        {data.usages.length === 0 && <div className="text-[12px] text-gray-400">No endpoint uses this step yet.</div>}
      </div>
    </div>
  );
}

function TableNode({ data }: NodeProps<Node<TableData>>) {
  return (
    <div className="meld-card flex w-[200px] items-center gap-3 px-3 py-2.5">
      <Handle type="target" position={Position.Top} id="in" className="meld-in" />
      <IconBox color={colorFor(data.module)} size={28}>
        <Database size={14} />
      </IconBox>
      <div>
        <Category>Table · {data.module}</Category>
        <div className="text-[14px] font-semibold text-gray-800">{data.name}</div>
      </div>
    </div>
  );
}

const nodeTypes = { usage: UsageNode, center: CenterNode, outcome: OutcomeNode, table: TableNode };

function Canvas({ view, step, open, select }: { view: AppView; step: StepView; open: (flow: string, node: string) => void; select: () => void }) {
  const graph = useMemo(() => {
    const nodes: Node[] = [{ id: "center", type: "center", position: { x: 0, y: 0 }, data: { step, select } }];
    const edges: Edge[] = [];
    step.usedBy.forEach((u, i) => {
      nodes.push({ id: `u${i}`, type: "usage", position: { x: 0, y: 0 }, data: { usage: u, view, open } });
      edges.push({ id: `u${i}->center`, source: `u${i}`, sourceHandle: "out", target: "center", targetHandle: "in" });
    });
    for (const o of step.outcomes) {
      nodes.push({ id: `o:${o.name}`, type: "outcome", position: { x: 0, y: 0 }, data: { step, outcome: o.name, usages: step.usedBy, view } });
      edges.push({ id: `center.${o.name}`, source: "center", sourceHandle: o.name, target: `o:${o.name}`, targetHandle: "in" });
    }
    for (const t of step.tables) {
      nodes.push({ id: `t:${t}`, type: "table", position: { x: 0, y: 0 }, data: { name: t, module: step.module } });
      edges.push({ id: `center->t:${t}`, source: "center", sourceHandle: "data", target: `t:${t}`, targetHandle: "in", className: "meld-input" });
    }
    return { nodes, edges };
  }, [view, step, open, select]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const initialized = useNodesInitialized();
  const rf = useReactFlow();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!initialized || ready) return;
    const measured = rf.getNodes();
    // tables sit under the step, outside the left-to-right layout
    const flowNodes = measured.filter((n) => n.type !== "table");
    layout(
      flowNodes.map((n) => ({ id: n.id, width: n.measured?.width ?? 300, height: n.measured?.height ?? 150, outPorts: n.id === "center" ? step.outcomes.map((o) => o.name) : ["out"] })),
      graph.edges.filter((e) => !e.target.startsWith("t:")).map((e) => ({ id: e.id, source: e.source, sourcePort: e.sourceHandle ?? undefined, target: e.target })),
      { spacing: 120 },
    ).then((pos) => {
      const center = pos.get("center") ?? { x: 0, y: 0 };
      const cm = measured.find((n) => n.id === "center")?.measured;
      const below = center.y + (cm?.height ?? 0) + 70;
      let tx = center.x;
      setNodes((ns) =>
        ns.map((n) => {
          if (n.type !== "table") return { ...n, position: pos.get(n.id) ?? n.position };
          const p = { x: tx, y: below };
          tx += 220;
          return { ...n, position: p };
        }),
      );
      setReady(true);
      requestAnimationFrame(() => rf.fitView({ padding: 0.15, duration: 250 }));
    });
  }, [initialized, ready, rf, graph, setNodes, step]);

  return (
    <div className="h-full w-full transition-opacity duration-200" style={{ opacity: ready ? 1 : 0 }}>
      <ReactFlow nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} nodesConnectable={false} minZoom={0.15} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="rgba(0,0,0,0.18)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function PieceView(props: { view: AppView; step: StepView; open: (flow: string, node: string) => void; select: () => void }) {
  return (
    <ReactFlowProvider key={`${props.step.key}:${props.step.usedBy.length}`}>
      <Canvas {...props} />
    </ReactFlowProvider>
  );
}
