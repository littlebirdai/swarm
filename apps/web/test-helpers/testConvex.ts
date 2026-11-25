import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import { convexToJson, jsonToConvex, type Value } from "convex/values";
import { offlineConvexClient } from "./offlineConvex";
import {
  TestSocket,
  type ClientFrame,
  type QueryUpdate,
  type Subscription,
} from "./convexWire";

type Kind = "query" | "mutation" | "action";
type Reply<Ref extends FunctionReference<Kind>> =
  | FunctionReturnType<Ref>
  | Error
  | ((args: FunctionArgs<Ref>) => FunctionReturnType<Ref> | Error);
type Resolver = (args: Value) => unknown;
type Write = { name: string; args: Value };

export function testConvex() {
  const queries = new Map<string, Resolver>();
  const writes = {
    Mutation: new Map<string, Resolver>(),
    Action: new Map<string, Resolver>(),
  };
  const mutations: Write[] = [];
  const actions: Write[] = [];
  const subscriptions = new Map<number, Subscription>();
  const unexpected = new Set<string>();
  let version = { querySet: 0, identity: 0, ts: timestamp(0) };
  let tick = 0;
  let socket: TestSocket | undefined;

  function timestamp(value: number) {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64LE(BigInt(value));
    return bytes.toString("base64");
  }

  function transition(
    modifications: QueryUpdate[],
    changes: Partial<typeof version> = {},
  ) {
    const startVersion = version;
    version = { ...version, ts: timestamp(++tick), ...changes };
    socket?.reply({
      type: "Transition",
      startVersion,
      endVersion: version,
      modifications,
    });
  }

  function update({ queryId, udfPath, args }: Subscription): QueryUpdate {
    const resolve = queries.get(udfPath);
    if (!resolve) unexpected.add(udfPath);
    let value;
    try {
      value = resolve
        ? resolve(jsonToConvex(args[0]))
        : new Error(`Unregistered query: ${udfPath}`);
      if (value === undefined) return { type: "QueryRemoved", queryId };
      if (!(value instanceof Error)) {
        return {
          type: "QueryUpdated",
          queryId,
          value: convexToJson(value as Value),
          logLines: [],
        };
      }
    } catch (error) {
      value = error;
    }
    return {
      type: "QueryFailed",
      queryId,
      errorMessage: String(value),
      logLines: [],
    };
  }

  function receive(frame: ClientFrame) {
    switch (frame.type) {
      case "Authenticate":
        transition([], { identity: frame.baseVersion + 1 });
        return;
      case "ModifyQuerySet":
        transition(
          frame.modifications.map((item) => {
            if (item.type === "Add") {
              subscriptions.set(item.queryId, item);
              return update(item);
            }
            subscriptions.delete(item.queryId);
            return { type: "QueryRemoved", queryId: item.queryId };
          }),
          { querySet: frame.newVersion },
        );
        return;
      case "Mutation":
      case "Action": {
        const args = jsonToConvex(frame.args[0]);
        const name = frame.udfPath;
        (frame.type === "Mutation" ? mutations : actions).push({ name, args });
        const response = {
          type: `${frame.type}Response`,
          requestId: frame.requestId,
          logLines: [],
        };
        try {
          const value = writes[frame.type].get(name)?.(args);
          if (value instanceof Error) throw value;
          const result = convexToJson((value ?? null) as Value);
          const ts = timestamp(tick + 1);
          socket?.reply({ ...response, success: true, result, ts });
          if (frame.type === "Mutation") transition([]);
        } catch (error) {
          socket?.reply({ ...response, success: false, result: String(error) });
        }
      }
    }
  }

  const client = offlineConvexClient(
    "https://mount-test.convex.cloud",
    class extends TestSocket {
      constructor() {
        super(receive);
        socket = this;
      }
    },
  );

  function resolver<Ref extends FunctionReference<Kind>>(
    reply: Reply<Ref> | undefined,
  ): Resolver {
    return typeof reply === "function"
      ? (args) => reply(args as FunctionArgs<Ref>)
      : () => reply;
  }

  return {
    client,
    mutations,
    actions,
    set<Ref extends FunctionReference<"query">>(
      ref: Ref,
      reply: Reply<Ref> | undefined,
    ) {
      const name = getFunctionName(ref);
      queries.set(name, resolver<Ref>(reply));
      const active = [...subscriptions.values()].filter(
        (sub) => sub.udfPath === name,
      );
      if (active.length) transition(active.map(update));
    },
    mutation<Ref extends FunctionReference<"mutation">>(
      ref: Ref,
      reply: Reply<Ref>,
    ) {
      writes.Mutation.set(getFunctionName(ref), resolver<Ref>(reply));
    },
    action<Ref extends FunctionReference<"action">>(
      ref: Ref,
      reply: Reply<Ref>,
    ) {
      writes.Action.set(getFunctionName(ref), resolver<Ref>(reply));
    },
    assertRegistered() {
      if (unexpected.size)
        throw new Error(
          `Unregistered Convex queries: ${[...unexpected].join(", ")}`,
        );
    },
  };
}
