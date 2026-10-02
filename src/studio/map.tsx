import {
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  MarkerType,
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
import { Boxes, Database, Globe, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Category, IconBox } from "./flow";
import { colorFor, layout, METHOD_COLORS } from "./util";
import type { AppView, ModuleView } from "./view";

// The whole app at a glance: every module, what it offers, and which modules
// depend on which (from their `uses` lines).

type ModuleData = { module: ModuleView; open: (name: string) => void };

function ModuleNode({ data }: NodeProps<Node<ModuleData>>) {
  const m = data.module;
  const shown = m.flows.slice(0, 8);
  return (
    <div className="meld-card w-[300px] cursor-pointer" onClick={() => data.open(m.name)}>
      <Handle type="target" position={Position.Left} id="in" className="meld-in" />
      <div className="meld-card-head px-3 py-2.5">
        <Category>Module</Category>
        <div className="mt-1 flex items-center gap-3">
          <IconBox color={colorFor(m.name)}>
            <Boxes size={17} />
          </IconBox>
          <div className="min-w-0">
            <div className="text-[16px] font-semibold leading-tight text-gray-800">{m.title ?? m.name}</div>
            <div className="meld-code text-[11px] text-gray-500">{m.name}</div>
          </div>
        </div>
      </div>
      <div className="flex gap-2 px-3 pt-2.5 text-[11px] text-gray-600">
        <span className="flex items-center gap-1 rounded bg-gray-50 px-1.5 py-0.5">
          <Globe size={11} /> {m.flows.length} endpoints
        </span>
        <span className="flex items-center gap-1 rounded bg-gray-50 px-1.5 py-0.5">
          <Workflow size={11} /> {m.steps.length} steps
        </span>
        <span className="flex items-center gap-1 rounded bg-gray-50 px-1.5 py-0.5">
          <Database size={11} /> {m.tables.length} tables
        </span>
      </div>
      <div className="px-3 pt-2 pb-3">
        {shown.map((f) => (
          <div key={f.key} className="flex items-center gap-1.5 py-0.5">
            <span className={`w-[46px] flex-none rounded px-1 py-0.5 text-center text-[9px] font-bold ${METHOD_COLORS[f.method] ?? ""}`}>{f.method}</span>
            <span className="meld-code truncate text-[11px] text-gray-600">{f.path}</span>
          </div>
        ))}
        {m.flows.length > shown.length && <div className="pt-1 text-[11px] text-gray-400">and {m.flows.length - shown.length} more</div>}
      </div>
      <Handle type="source" position={Position.Right} id="out" className="meld-out" />
    </div>
  );
}

const nodeTypes = { module: ModuleNode };

function Map_({ view, open }: { view: AppView; open: (name: string) => void }) {
  const graph = useMemo(() => {
    const nodes: Node[] = view.modules.map((m) => ({ id: m.name, type: "module", position: { x: 0, y: 0 }, data: { module: m, open } }));
    // arrows point from the module that is used to the module that uses it, so the map reads left to right
    const edges: Edge[] = view.links.map((l) => ({
      id: `${l.from}->${l.to}`,
      source: l.to,
      sourceHandle: "out",
      target: l.from,
      targetHandle: "in",
      label: l.steps.length > 2 ? `${l.steps.slice(0, 2).join(", ")} +${l.steps.length - 2} more` : l.steps.join(", "),
      labelStyle: { fontSize: 11, fill: "#475569" },
      labelBgStyle: { fill: "#fff" },
      labelBgPadding: [6, 3] as [number, number],
      labelBgBorderRadius: 4,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#60a5fa" },
    }));
    return { nodes, edges };
  }, [view, open]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  const initialized = useNodesInitialized();
  const rf = useReactFlow();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!initialized || ready) return;
    layout(
      rf.getNodes().map((n) => ({ id: n.id, width: n.measured?.width ?? 300, height: n.measured?.height ?? 200, outPorts: ["out"] })),
      graph.edges.map((e) => ({ id: e.id, source: e.source, sourcePort: "out", target: e.target })),
      { spacing: 220 },
    ).then((pos) => {
      setNodes((ns) => ns.map((n) => ({ ...n, position: pos.get(n.id) ?? n.position })));
      setReady(true);
      requestAnimationFrame(() => rf.fitView({ padding: 0.2, duration: 250 }));
    });
  }, [initialized, ready, rf, graph, setNodes]);

  return (
    <div className="h-full w-full transition-opacity duration-200" style={{ opacity: ready ? 1 : 0 }}>
      <ReactFlow nodes={nodes} edges={graph.edges} nodeTypes={nodeTypes} onNodesChange={onNodesChange} nodesConnectable={false} proOptions={{ hideAttribution: true }}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1.3} color="rgba(0,0,0,0.18)" />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

export function SystemMap(props: { view: AppView; open: (name: string) => void }) {
  return (
    <ReactFlowProvider>
      <Map_ {...props} />
    </ReactFlowProvider>
  );
}
