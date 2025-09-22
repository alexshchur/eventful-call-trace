import { ethers } from "ethers";
import { cachedFetchJson } from "./helpers/lib";
import { LogLike, StructLogStep, TraceCall } from "../types";
import {
  enrichTraceWithCallAndEventDetails,
  ReceiptLog,
  stitchLogsIntoCallTrace,
} from "../lib/stitch-receipt-logs-into-calltracer";

/**
 * Returns a mapping from method name to events found in the enriched call tree.
 * @param methodNames Array of method names to match (e.g. ['transfer', 'approve'])
 * @param eventNames Array of event names to match (e.g. ['Transfer', 'Approval'])
 * @param enrichedTree The enriched call tree (CallNode or CallNode[])
 * @returns Record<methodName, Array<{call: CallNode, event: any}>>
 */
function mapMethodsToEvents(
  methodNames: string[],
  eventNames: string[],
  enrichedTree: any
): Record<string, Array<any>> {
  const result: Record<string, Array<any>> = {};
  for (const name of methodNames) result[name] = [];

  // Recursively collect all matching events in a call and its descendants
  function collectEvents(call: any): Array<{ parsed_event: any }> {
    let events: Array<{ parsed_event: any }> = [];
    if (Array.isArray(call.logs)) {
      for (const log of call.logs) {
        if (log.parsed && eventNames.includes(log.parsed.name)) {
          events.push({ parsed_event: log.parsed });
        }
      }
    }
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) {
        events = events.concat(collectEvents(child));
      }
    }
    return events;
  }

  // Traverse the tree, and for each method call, collect all events in its subtree
  function visit(call: any) {
    if (call.method && methodNames.includes(call.method)) {
      const events = collectEvents(call);
      result[call.method].push(...events);
    }
    if (Array.isArray(call.calls)) {
      for (const child of call.calls) visit(child);
    }
  }
  if (Array.isArray(enrichedTree)) {
    for (const call of enrichedTree) visit(call);
  } else {
    visit(enrichedTree);
  }
  return result;
}

/**
 * contains output of the following call:
 * 
 * {
  "jsonrpc": "2.0",
  "method": "debug_traceTransaction",
  "id": 1,
  "params": [
    "'$TX_HASH'",
    {
        "disableStack": true,
        "disableMemory": true,
        "disableStorage": true,
        "enableReturnData": false,
        "timeout": "60s",
        "reexec": 100000000
      }
  ]
}
 */

const TX_HASH = process.env.TX_HASH;
const opcodes = cachedFetchJson(
  `bash ./src/examples/shell-scripts/fetch-debug_traceTransaction-logs.sh ${TX_HASH}`
);

/** contains output of the following call:
 * 
 * {
  "jsonrpc": "2.0",
  "method": "eth_getTransactionReceipt",
  "id": 1,
  "params": [
    "'$TX_HASH'"
  ]
} 
 * 
 */

const receipt = cachedFetchJson(
  `bash ./src/examples/shell-scripts/fetch-eth_getTransactionReceipt.sh ${TX_HASH}`
);

/**
 * contains output of the following call:
 * 
 * {
  "jsonrpc": "2.0",
  "method": "debug_traceTransaction",
  "id": 1,
  "params": [
    "'$TX_HASH'",
    {"tracer":"callTracer"}
  ]
}
 */
const trace = cachedFetchJson(
  `bash ./src/examples/shell-scripts/fetch-debug_traceTransaction.sh ${TX_HASH}`
);

const callsFromCallTracer: TraceCall | TraceCall[] = trace.result;
const logsFromReceipt: LogLike[] = receipt.result.logs;
const structs: StructLogStep[] = opcodes.result.structLogs;

// Migrator method selectors and topic
const migrator_methods_by_selector = {
  "0x39b5cd5d": "migrateSePSP1toVLR",
  "0x174a81ab": "migratePSPtoVLR",
  "0x8dad50f2": "migratePSPtoSeVLR",
  "0x3c745a4f": "migrateSePSP1toSeVLR",
  "0xee06090b": "migrateSePSP2toSeVLR",
};

const bridge_in_methods_by_selector = {
  "0xf7112225": "bridgeVLRAndStake",
  "0x7854eb6c": "migrateSePSP2toSeVLRAndBridge",
};

const transfer_selectors = {
  "0xa9059cbb": "transfer",
  "0x23b872dd": "transferFrom",
  "0x42842e0e": "safeTransferFrom",
  "0xb88d4fde": "safeTransferFrom",
};

const permit_selectors = {
  "0xd505accf": "permit",
  "0x8fcbaf0c": "permit",
  "0x4e71d92d": "permit",
  "0x2e1a7d4d": "permit",
  "0x6e71edae": "permit",
  "0x5c975abb": "permit",
  "0x7a0ed627": "permit",
};

const approve_selectors = {
  "0x095ea7b3": "approve",
};

const tokens_address_by_label: Record<string, string> = {
  sePSP2: "0x26ee65874f5dbefa629eb103e7bbb2deaf4fb2c8",
  psp: "0xd3594e879b358f430e20f82bea61e83562d49d48",
  vlr: "0x4e107a0000db66f0e9fd2039288bf811dd1f9c74",
  weth: "0x4200000000000000000000000000000000000006",
  sePSP1: "0x8C934b7dBc782568d14ceaBbEAeDF37cB6348615",
  seVLR: "0x40000320d200c110100638040f10500C8f0010B9",
  BPT_psp: "0x11f0b5cca01b0f0a9fe6265ad6e8ee3419c68440",
  BPT_vlr: "0x9620b74077e2a9f118cd37ef60001aeb327ec1a7",
  BPT_vlr_fees_collector: "0xce88686553686da562ce7cea497ce749da109f9f",
} as const;

const token_symbol_by_address: Record<string, string> = Object.fromEntries(
  Object.entries(tokens_address_by_label).map(([k, v]) => [v.toLowerCase(), k])
);

const miro_migrator_address =
  "0x3F06Aa8fFF196F9d5033553ca035aa09FAE6492c".toLowerCase();

const ADDRESS_TO_LABEL = {
  [miro_migrator_address]: "miro_migrator",
  "0x0000000000000000000000000000000000000000": "ZERO_ADDRESS",
  "0x000000000000000000000000000000000000dead": "ZERO_ADDRESS",
  "0xba12222222228d8ba445958a75a0704d566bf2c8": "balancer_vault",
  // ["".toLowerCase()]:
  //   "Blue Rev (BPT-BREV)",
};
const TOPIC_PARSERS = {
  Transfer: (log: ReceiptLog) => {
    const result = {
      token: log.address,
      from: `0x${log.topics[1].slice(26)}`,
      to: `0x${log.topics[2].slice(26)}`,
      value: BigInt(log.data).toString(),
    };

    if (ADDRESS_TO_LABEL[result.from])
      (result as any).fromLabel = ADDRESS_TO_LABEL[result.from];
    else if (token_symbol_by_address[result.from])
      (result as any).fromLabel = token_symbol_by_address[result.from];

    if (ADDRESS_TO_LABEL[result.to])
      (result as any).toLabel = ADDRESS_TO_LABEL[result.to];
    else if (token_symbol_by_address[result.to])
      (result as any).toLabel = token_symbol_by_address[result.to];

    if (token_symbol_by_address[log.address.toLowerCase()]) {
      (result as any).tokenSymbol =
        token_symbol_by_address[log.address.toLowerCase()];
    }
    return result;
  },

  Approval: (log: ReceiptLog) => {
    return {
      owner: `0x${log.topics[1].slice(26)}`,
      spender: `0x${log.topics[2].slice(26)}`,
      value: BigInt(log.data).toString(),
    };
  },
};

const TOPICS: Record<
  string,
  { name: string; parser: (log: ReceiptLog) => any }
> = {
  "0x782334e555e7f5df3383da5b8d85e76ac57c38b6385a8ee43961e2064c587895": {
    // StakeBridgingInitiated (index_topic_1 address user, index_topic_2 uint256 vlrAmount, index_topic_3 uint256 wethAmount, uint256 destChainId, bytes message)
    name: "StakeBridgingInitiated",
    parser: (log: ReceiptLog) => {
      const abi = [
        "event StakeBridgingInitiated(address indexed user, uint256 indexed vlrAmount, uint256 indexed wethAmount, uint256 destChainId, bytes message)",
      ];
      const iface = new ethers.Interface(abi);
      // Convert log to the format expected by ethers
      const parsedLog = iface.parseLog({
        topics: log.topics,
        data: log.data,
      });
      if (!parsedLog) throw new Error("Failed to parse log");
      return {
        user: parsedLog.args.user,
        vlrAmount: BigInt(parsedLog.args.vlrAmount).toString(),
        wethAmount: BigInt(parsedLog.args.wethAmount).toString(),
        destChainId: BigInt(parsedLog.args.destChainId).toString(),
        message: parsedLog.args.message,
      };
    },
  },
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef": {
    name: "Transfer",
    parser: TOPIC_PARSERS["Transfer"],
  },
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925": {
    name: "Approval",
    parser: TOPIC_PARSERS["Approval"],
  },
};

const SELECTORS: Record<string, string> = {
  ...{
    "0x745400c9": "requestWithdraw",
    "0x74f3b009": "onExitPool",
    "0x8bdb3913": "exitPool",
    "0xb0d88d7f": "withdrawPSPAndWeth",
    "0xd5c096c4": "onJoinPool",
    "0xb95cac28": "joinPool",
    "0xc9fdcb4c": "depositVLRAndWeth",
  },
  ...migrator_methods_by_selector,
  ...bridge_in_methods_by_selector,
  ...transfer_selectors,
  ...permit_selectors,
  ...approve_selectors,
};

const all_outer_methods = Object.values({
  ...migrator_methods_by_selector,
  ...bridge_in_methods_by_selector,
});

type TransferEvent = {
  name: "Transfer";
  params: {
    token: string;
    from: string;
    to: string;
    value: string;
    tokenSymbol?: string;
    fromLabel?: string;
    toLabel?: string;
  };
};
type StakeBridgingInitiatedEvent = {
  name: "StakeBridgingInitiated";
  params: {
    user: string;
    vlrAmount: string;
    wethAmount: string;
    destChainId: string;
    message: string;
  };
};
type Condensed = Record<
  string,
  {
    parsed_event: TransferEvent | StakeBridgingInitiatedEvent;
  }[]
>;
//
const { root: enriched } = stitchLogsIntoCallTrace({
  callsFromCallTracer,
  structLogs: structs,
  receipt: { logs: logsFromReceipt },
});
// console.log("enriched", JSON.stringify(enriched, null, 2));
// process.exit();

enrichTraceWithCallAndEventDetails(enriched, SELECTORS, TOPICS);

const condensed: Condensed = mapMethodsToEvents(
  all_outer_methods,
  ["Transfer", "StakeBridgingInitiated"],
  enriched
);

// console.log(JSON.stringify(condensed, null, 2));
// process.exit();

const recognized_by_method: Record<any, any> = {};
const condensed_transformed = Object.fromEntries(
  Object.entries(condensed).map(([method, events]) => {
    const by_token = Object.fromEntries(
      Object.entries(
        events.reduce((acc, curr) => {
          if (!recognized_by_method[method]) recognized_by_method[method] = {};

          if (curr.parsed_event.name === "Transfer") {
            const token =
              curr.parsed_event.params.tokenSymbol ||
              curr.parsed_event.params.token;
            if (!acc[token]) acc[token] = [];
            acc[token].push(curr.parsed_event);

            if (!recognized_by_method[method][token])
              recognized_by_method[method][token] = {};

            const key: string[] = [];
            if (curr.parsed_event.params.fromLabel) {
              key.push("from-" + curr.parsed_event.params.fromLabel);
            }

            if (curr.parsed_event.params.toLabel) {
              key.push("to-" + curr.parsed_event.params.toLabel);
            }
            const keyStr = key.join("|");
            if (keyStr) {
              recognized_by_method[method][token][keyStr] = curr.parsed_event;
            }

            return acc;
          }

          if (curr.parsed_event.name === "StakeBridgingInitiated") {
            if (!recognized_by_method[method]["StakeBridgingInitiated"])
              recognized_by_method[method]["StakeBridgingInitiated"] = [];

            recognized_by_method[method]["StakeBridgingInitiated"].push(
              curr.parsed_event
            );

            if (!acc["StakeBridgingInitiated"])
              acc["StakeBridgingInitiated"] = [];
            acc["StakeBridgingInitiated"].push(curr.parsed_event);
            return acc;
          }

          throw new Error(
            "Unexpected event " + JSON.stringify(curr.parsed_event)
          );
        }, {} as Record<string, (TransferEvent | StakeBridgingInitiatedEvent)[]>)
      )
    );
    return [method, by_token];
  })
);
// console.log(JSON.stringify(condensed_transformed, null, 2));
console.log(JSON.stringify(recognized_by_method, null, 2));
