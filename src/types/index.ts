// Shared type definitions for EVM trace tools

export type TraceCall = {
  type?: string;
  from?: string;
  to?: string;
  input?: string;
  value?: string;
  calls?: TraceCall[];
};

export type LogLike = {
  address: string;
  topics: string[];
  data: string;
  logIndex?: number;
};
export interface StructLogStep {
  op: string; // 'CALL', 'LOG3', etc.
  depth: number;
  pc: number;
}

export type Pair = { call: TraceCall; event: LogLike };
