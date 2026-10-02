import { Check, Loader2, Pencil, Sparkles, Wand2, X } from "lucide-react";
import { useState, type ReactNode } from "react";

// Changing the app from the studio. People change explanations and describe
// what they want; the AI writes the code, Meld checks the whole app, and the
// person approves a plain-language summary. Code is never shown.

export interface Target {
  kind: "module" | "step" | "flow" | "fn" | "table";
  module: string;
  name: string;
}

export interface Proposal {
  id: string;
  summary: string;
  doc: string;
  changes: string[];
  problems: string[];
  attempts: number;
}

export async function api<T = unknown>(path: string, body?: unknown, method = "POST"): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", "x-meld-studio": "1" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string; problems?: string[] };
  if (!res.ok) throw new Error(data.error ?? data.problems?.join("\n") ?? `Request failed (${res.status})`);
  return data as T;
}

export function Busy({ children }: { children: ReactNode }) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-blue-50 px-3 py-2 text-[12px] text-blue-700">
      <Loader2 size={13} className="animate-spin" /> {children}
    </div>
  );
}

export function ErrorNote({ message, onClose }: { message: string; onClose?: () => void }) {
  return (
    <div className="flex items-start gap-2 rounded-md bg-rose-50 px-3 py-2 text-[12px] whitespace-pre-wrap text-rose-700">
      <span className="flex-1">{message}</span>
      {onClose && (
        <button onClick={onClose} className="text-rose-400 hover:text-rose-700">
          <X size={13} />
        </button>
      )}
    </div>
  );
}

const btn = "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] font-semibold disabled:opacity-50";
export const primaryBtn = `${btn} bg-blue-600 text-white hover:bg-blue-700`;
export const secondaryBtn = `${btn} border border-gray-200 text-gray-700 hover:bg-gray-50`;

function ProposalView({ proposal, onApplied, onDiscard }: { proposal: Proposal; onApplied: () => void; onDiscard: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const blocked = proposal.problems.length > 0;
  return (
    <div className="space-y-2 rounded-md border border-violet-200 bg-violet-50/40 p-3">
      <div className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-violet-700">
        <Sparkles size={12} /> Proposed change
      </div>
      <div className="text-[13px] text-gray-800">{proposal.summary}</div>
      {proposal.changes.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">What else changes</div>
          <ul className="mt-1 list-disc pl-5 text-[12px] text-gray-700">
            {proposal.changes.map((c) => (
              <li key={c}>{c}</li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">New explanation</div>
        <div className="mt-1 text-[12px] whitespace-pre-wrap text-gray-700">{proposal.doc}</div>
      </div>
      {blocked ? (
        <ErrorNote message={`Meld couldn't make this work after ${proposal.attempts} tries:\n${proposal.problems.map((p) => `• ${p.replace(/^[^:]+:\d+:\d+: /, "")}`).join("\n")}`} />
      ) : (
        <div className="flex items-center gap-1.5 text-[12px] text-emerald-700">
          <Check size={13} /> Meld checked the whole app with this change: no problems.
        </div>
      )}
      {error && <ErrorNote message={error} onClose={() => setError(null)} />}
      <div className="flex gap-2 pt-1">
        <button
          disabled={busy || blocked}
          className={primaryBtn}
          onClick={async () => {
            setBusy(true);
            try {
              await api(`/_meld/proposals/${proposal.id}/apply`);
              onApplied();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          <Check size={13} /> Apply
        </button>
        <button disabled={busy} className={secondaryBtn} onClick={onDiscard}>
          Discard
        </button>
      </div>
    </div>
  );
}

/**
 * The explanation of a module, step, flow, helper or table, editable.
 * For steps, flows and helpers, a changed explanation can be turned into new
 * behavior by the AI.
 */
export function ExplanationEditor({ target, doc, onChanged }: { target: Target; doc?: string; onChanged: () => void }) {
  const [mode, setMode] = useState<"view" | "edit">("view");
  const [text, setText] = useState(doc ?? "");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const behavioral = target.kind === "step" || target.kind === "flow" || target.kind === "fn";

  const run = async (label: string, f: () => Promise<void>) => {
    setBusy(label);
    setError(null);
    try {
      await f();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  if (proposal) {
    return (
      <ProposalView
        proposal={proposal}
        onApplied={() => {
          setProposal(null);
          setMode("view");
          onChanged();
        }}
        onDiscard={() => setProposal(null)}
      />
    );
  }

  if (mode === "edit") {
    return (
      <div className="space-y-2">
        <textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="h-36 w-full rounded-md border border-gray-200 p-2 text-[13px] leading-relaxed outline-none focus:border-blue-400"
          placeholder="Say what this does, one sentence per line."
        />
        {busy && <Busy>{busy}</Busy>}
        {error && <ErrorNote message={error} onClose={() => setError(null)} />}
        <div className="flex flex-wrap gap-2">
          {behavioral && (
            <button
              disabled={!!busy || !text.trim() || text.trim() === (doc ?? "").trim()}
              className={primaryBtn}
              title="The AI changes the behavior to match, then Meld checks the whole app"
              onClick={() => run("The AI is updating the behavior to match, and Meld is checking it…", async () => setProposal(await api<Proposal>("/_meld/propose", { target, doc: text })))}
            >
              <Wand2 size={13} /> Make it do this
            </button>
          )}
          <button
            disabled={!!busy || !text.trim()}
            className={behavioral ? secondaryBtn : primaryBtn}
            title={behavioral ? "Only fixes the wording; what it does stays the same" : undefined}
            onClick={() =>
              run("Saving…", async () => {
                await api("/_meld/doc", { target, doc: text });
                setMode("view");
                onChanged();
              })
            }
          >
            {behavioral ? "Just fix the wording" : "Save"}
          </button>
          <button disabled={!!busy} className={secondaryBtn} onClick={() => (setMode("view"), setText(doc ?? ""), setError(null))}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {doc ? (
        <div className="group relative">
          <div className="pr-6 text-[13px] leading-relaxed whitespace-pre-wrap text-gray-700">{doc}</div>
          <button onClick={() => (setText(doc), setMode("edit"))} className="absolute top-0 right-0 rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-blue-600" title="Change the explanation">
            <Pencil size={13} />
          </button>
        </div>
      ) : (
        <div className="text-[13px] text-gray-400">No explanation yet.</div>
      )}
      {busy && <Busy>{busy}</Busy>}
      {error && <ErrorNote message={error} onClose={() => setError(null)} />}
      {!doc && (
        <div className="flex gap-2">
          <button
            disabled={!!busy}
            className={primaryBtn}
            onClick={() =>
              run("The AI is reading it and writing an explanation…", async () => {
                const r = await api<{ doc: string }>("/_meld/explain", { target });
                setText(r.doc);
                setMode("edit");
              })
            }
          >
            <Sparkles size={13} /> Write it with AI
          </button>
          <button disabled={!!busy} className={secondaryBtn} onClick={() => (setText(""), setMode("edit"))}>
            Write it myself
          </button>
        </div>
      )}
    </div>
  );
}

/** "Ask for a change" in plain words. */
export function ChangeBox({ target, onChanged }: { target: Target; onChanged: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  if (proposal) {
    return (
      <ProposalView
        proposal={proposal}
        onApplied={() => {
          setProposal(null);
          setText("");
          onChanged();
        }}
        onDiscard={() => setProposal(null)}
      />
    );
  }
  return (
    <div className="space-y-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        className="h-20 w-full rounded-md border border-gray-200 p-2 text-[13px] outline-none focus:border-blue-400"
        placeholder={`Describe what should be different, e.g. "also refuse titles longer than 120 characters"`}
      />
      {busy && <Busy>The AI is making the change, and Meld is checking the whole app…</Busy>}
      {error && <ErrorNote message={error} onClose={() => setError(null)} />}
      <button
        disabled={busy || !text.trim()}
        className={primaryBtn}
        onClick={async () => {
          setBusy(true);
          setError(null);
          try {
            setProposal(await api<Proposal>("/_meld/propose", { target, instruction: text }));
          } catch (e) {
            setError((e as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <Wand2 size={13} /> Propose the change
      </button>
    </div>
  );
}

/** A title you can rename in place. */
export function EditableTitle({ target, title, className, onChanged }: { target: Target; title: string; className?: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(title);
  const [error, setError] = useState<string | null>(null);
  if (!editing) {
    return (
      <span className={`group inline-flex items-center gap-1.5 ${className ?? ""}`}>
        {title}
        <button onClick={() => (setText(title), setEditing(true))} className="rounded p-0.5 text-gray-300 opacity-0 group-hover:opacity-100 hover:text-blue-600" title="Rename">
          <Pencil size={12} />
        </button>
      </span>
    );
  }
  const save = async () => {
    try {
      if (text.trim() && text.trim() !== title) await api("/_meld/title", { target, title: text.trim() });
      setEditing(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <span className="inline-flex flex-col">
      <input
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => (e.key === "Enter" ? save() : e.key === "Escape" ? setEditing(false) : null)}
        onBlur={save}
        className={`rounded border border-blue-300 px-1 outline-none ${className ?? ""}`}
      />
      {error && <span className="text-[11px] text-rose-600">{error}</span>}
    </span>
  );
}
