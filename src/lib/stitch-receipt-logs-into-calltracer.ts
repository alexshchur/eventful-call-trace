// stitch-receipt-logs-into-calltracer.ts

import { TraceCall } from "../types";

// minimal inputs
export interface StructLogStep {
  op: string;
  depth: number;
  pc: number;
}
export interface ReceiptLog {
  address: string;
  topics: string[];
  data: string;
  logIndex?: string | number;
}
export interface TxReceipt {
  logs: ReceiptLog[];
}

// callTracer node (keep it permissive)
export interface CallNode {
  method?: string; // decorated
  type?:
    | "CALL"
    | "STATICCALL"
    | "DELEGATECALL"
    | "CALLCODE"
    | "CREATE"
    | "CREATE2"
    | string;
  from?: string;
  to?: string;
  input?: string;
  output?: string;
  value?: string;
  gas?: string;
  gasUsed?: string;
  calls?: CallNode[];
  // will be added by this tool:
  logs?: ReceiptLog[];
  _path?: number[]; // for debugging
}

// your callTracer root can be a single node or an array of top-level calls
export type CallTracerRoot = TraceCall | TraceCall[];
export type CallTracerRootResult = CallNode | CallNode[];

// 1) Derive LOG* -> callPath[] and eventIdxInCall, dropping logs from reverted frames
export interface EventPath {
  op: "LOG0" | "LOG1" | "LOG2" | "LOG3" | "LOG4" | string;
  pc: number;
  depth: number;
  callPath: number[];
  eventIdxInCall: number;
}

export function deriveEventPathsRevertAware(
  steps: StructLogStep[]
): EventPath[] {
  const ENTER = new Set([
    "CALL",
    "STATICCALL",
    "DELEGATECALL",
    "CALLCODE",
    "CREATE",
    "CREATE2",
  ]);

  type Frame = {
    path: number[]; // e.g. [], [0], [0,1], ...
    nextChild: number; // next child index for this frame
    logsIdx: number[]; // event indices emitted within this frame
    reverted: boolean; // set when we see REVERT in this frame
  };

  // virtual root frame at path []
  const frames: Frame[] = [
    { path: [], nextChild: 0, logsIdx: [], reverted: false },
  ];

  let prevDepth = steps.length ? steps[0].depth : 1;

  // reserve a child slot at the CALL/CREATE step; confirm only if depth increases next step
  let pending: { parentIdx: number; reservedIdx: number } | null = null;

  const events: {
    op: EventPath["op"];
    pc: number;
    depth: number;
    callPath: number[];
    dropped?: boolean;
  }[] = [];

  for (let i = 0; i < steps.length; i++) {
    const s = steps[i];
    const { op, depth: d } = s;

    // resolve pending reservation from the previous step
    if (pending) {
      if (d > prevDepth) {
        const parent = pending.parentIdx;
        const idx = pending.reservedIdx;
        const newPath = frames[parent].path.concat(idx);
        frames.push({
          path: newPath,
          nextChild: 0,
          logsIdx: [],
          reverted: false,
        });
      }
      // else: zero-step callee; ignore (callTracer doesn't count it)
      pending = null;
    }

    // pop frames on depth drops (depth is 1-based; frames.length-1 is current depth)
    while (frames.length - 1 > d - 1) {
      const f = frames.pop();
      if (f?.reverted) {
        // drop logs emitted in a reverted frame (they won't appear in receipt)
        for (const idx of f.logsIdx) events[idx].dropped = true;
      }
    }

    if (ENTER.has(op)) {
      const parentIdx = frames.length - 1;
      const idx = frames[parentIdx].nextChild;
      frames[parentIdx].nextChild += 1;
      pending = { parentIdx, reservedIdx: idx };
    }

    if (op.startsWith("LOG")) {
      const cur = frames[frames.length - 1];
      const evIdx = events.length;
      cur.logsIdx.push(evIdx);
      events.push({
        op,
        pc: s.pc,
        depth: d,
        callPath: cur.path.slice(),
      });
    }

    if (op === "REVERT") {
      // mark current frame as reverted; actual pop happens on next depth change
      frames[frames.length - 1].reverted = true;
    }

    prevDepth = d;
  }

  // if we ended right after a zero-step CALL/CREATE, clear the pending reservation
  if (pending) pending = null;

  // assign per-call event indices and drop reverted ones
  const counters = new Map<string, number>();
  const out: EventPath[] = [];
  for (const e of events) {
    if (e.dropped) continue;
    const key = e.callPath.join("/");
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    out.push({
      op: e.op,
      pc: e.pc,
      depth: e.depth,
      callPath: e.callPath,
      eventIdxInCall: n,
    });
  }
  return out; // execution order preserved
}

// 2) Annotate callTracer nodes with their callPath
export function annotateCallPaths(root: CallTracerRoot): Map<string, CallNode> {
  const pathMap = new Map<string, CallNode>();

  const visit = (node: CallNode, prefix: number[] = []) => {
    node._path = [...prefix];
    pathMap.set(prefix.join("/"), node);
    const kids = node.calls ?? [];
    for (let i = 0; i < kids.length; i++) visit(kids[i], [...prefix, i]);
  };

  // If root is an array, register each top-level node with its own path
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i++) {
      visit(root[i], [i]);
    }
  } else {
    // If root is a single node, register it at path []
    visit(root as CallNode, []);
  }

  return pathMap;
}

// 3) Decide what address should be emitting logs in a given call node
export function expectedLogAddressForNode(n: CallNode): string | undefined {
  if (!n) return undefined;
  const t = n.type;
  if (t === "DELEGATECALL" || t === "CALLCODE") return n.from?.toLowerCase();
  // for CREATE/CREATE2, callTracer typically fills 'to' with the created address
  return n.to?.toLowerCase();
}

// 4) Stitch receipt logs into the call tree following event paths
export interface InjectResult {
  root: CallTracerRootResult;
  warnings: string[];
}

export function stitchLogsIntoCallTrace({
  callsFromCallTracer,
  structLogs,
  receipt,
  suppressWarnings = false,
}: {
  callsFromCallTracer: CallTracerRoot;
  structLogs: StructLogStep[];
  receipt: TxReceipt;
  suppressWarnings?: boolean;
}): InjectResult {
  const warnings: string[] = [];

  const events = deriveEventPathsRevertAware(structLogs);
  const pathMap = annotateCallPaths(callsFromCallTracer);

  if (events.length !== receipt.logs.length) {
    warnings.push(
      `events from structLogs (${events.length}) != receipt logs (${receipt.logs.length}). Will attach sequentially.`
    );
  }

  // init logs arrays
  for (const [, node] of pathMap) node.logs = [];

  // attach logs by global order
  const logs = receipt.logs;
  let li = 0;
  for (let i = 0; i < events.length && li < logs.length; i++, li++) {
    const e = events[i];
    const key = e.callPath.join("/");
    const node = pathMap.get(key);
    if (!node) {
      warnings.push(
        `no callTracer node for path [${key}] at receipt log #${li}`
      );
      continue;
    }
    const log = logs[li];
    // optional sanity check on address
    const expectedAddr = expectedLogAddressForNode(node);
    if (
      expectedAddr &&
      log.address &&
      expectedAddr !== log.address.toLowerCase()
    ) {
      warnings.push(
        `address mismatch at path [${key}]: expected ${expectedAddr}, got ${log.address.toLowerCase()} (log #${li})`
      );
    }
    (node.logs as ReceiptLog[]).push(log);
  }

  // any leftover logs if counts mismatched
  for (; li < logs.length; li++) {
    warnings.push(`leftover receipt log #${li} not mapped`);
  }

  if (warnings.length > 0 && !suppressWarnings) {
    throw new Error(
      "Warnings during stitchLogsIntoCallTrace:\n" + warnings.join("\n")
    );
  }

  return { root: callsFromCallTracer, warnings };
}

/**
 * Enriches a trace with method name and parsed event details for each call and event.
 * @param enriched The trace (CallNode or CallNode[]) with events injected.
 * @param selectors Mapping of method selectors to names.
 * @param topics Mapping of event topics to parsers and names.
 * @returns The same structure, but each call has method name and each event has parsed params.
 */
export function enrichTraceWithCallAndEventDetails(
  enriched: CallNode | CallNode[],
  selectors: Record<string, string>,
  topics: Record<string, { name: string; parser: (log: ReceiptLog) => any }>
) {
  // Helper to decode method name from input data
  function getMethodName(input: string): string {
    if (!input || input.length < 10) return "unknown";
    // First 4 bytes (8 hex chars) after '0x' is the selector
    const selector = input.slice(0, 10);
    if (selectors[selector] != null) return selectors[selector];
    // You may want to map selector to known methods here
    return selector;
  }
  // Helper to parse event params from topics/data
  function parseEvent(log: ReceiptLog): any {
    // Basic: return topics and data
    const code = log.topics[0];
    const details = topics[code];
    if (details && details.parser) {
      return {
        name: details.name,
        params: details.parser(log),
      };
    }

    return {
      topics: log.topics,
      data: log.data,
    };
  }
  function enrichCall(call: CallNode): CallNode {
    // Add method name
    call.method = call.input
      ? getMethodName(call.input)
      : call.input?.substring(0, 10);
    // Enrich events
    if (call.logs) {
      call.logs = call.logs.map((log: ReceiptLog) => ({
        ...log,
        parsed: parseEvent(log),
      }));
    }
    // Recurse into child calls
    if (call.calls) {
      call.calls = call.calls.map(enrichCall);
    }
    return call;
  }
  if (Array.isArray(enriched)) {
    return enriched.map(enrichCall);
  } else {
    return enrichCall(enriched);
  }
}
