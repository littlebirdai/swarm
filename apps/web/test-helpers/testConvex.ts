import {
  getFunctionName,
  type FunctionArgs,
  type FunctionReference,
  type FunctionReturnType,
} from "convex/server";
import {
  ConvexError,
  convexToJson,
  jsonToConvex,
  type Value,
} from "convex/values";
import { offlineConvexClient } from "./offlineConvex";
import {
  TestSocket,
  type ClientFrame,
  type QueryUpdate,
  type Subscription,
} from "./convexWire";

export const pending = Symbol("pending query");

type Kind = "query" | "mutation" | "action";
type Result<Ref extends FunctionReference<Kind>> =
  | FunctionReturnType<Ref>
  | Error
  | undefined;
type QueryResult<Ref extends FunctionReference<"query">> =
  | Result<Ref>
  | typeof pending;
type QueryReply<Ref extends FunctionReference<"query">> =
  | QueryResult<Ref>
  | ((args: FunctionArgs<Ref>) => QueryResult<Ref>);
type WriteReply<Ref extends FunctionReference<"mutation" | "action">> =
  | Result<Ref>
  | ((args: FunctionArgs<Ref>) => Result<Ref> | Promise<Result<Ref>>);
type Resolver = (args: Value) => unknown;
type Write = { name: string; args: Value };

export function testConvex() {
  const queries = new Map<string, Resolver>();
  const writes = {
    Mutation: new Map<string, Resolver>(),
    Action: new Map<string, Resolver>(),
  };
  const queryRequests: Write[] = [];
  const mutations: Write[] = [];
  const actions: Write[] = [];
  const writeRequests: (Write & { kind: "Mutation" | "Action" })[] = [];
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

  const errorData = (error: unknown) =>
    error instanceof ConvexError ? { errorData: convexToJson(error.data) } : {};

  function recordUnexpected(kind: string, name: string) {
    const message = `Unregistered Convex ${kind}: ${name}`;
    unexpected.add(message);
    return new Error(message);
  }

  function update({ queryId, udfPath, args }: Subscription): QueryUpdate {
    const resolve = queries.get(udfPath);
    let value;
    try {
      value = resolve
        ? resolve(jsonToConvex(args[0]))
        : recordUnexpected("query", udfPath);
      if (value === pending) return { type: "QueryRemoved", queryId };
      if (!(value instanceof Error)) {
        return {
          type: "QueryUpdated",
          queryId,
          value: convexToJson((value ?? null) as Value),
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
      ...errorData(value),
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
              queryRequests.push({
                name: item.udfPath,
                args: jsonToConvex(item.args[0]),
              });
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
        writeRequests.push({ kind: frame.type, name, args });
        (frame.type === "Mutation" ? mutations : actions).push({ name, args });
        const response = {
          type: `${frame.type}Response`,
          requestId: frame.requestId,
          logLines: [],
        };
        const kind = frame.type;
        void respondToWrite();
        async function respondToWrite() {
          try {
            const resolve = writes[kind].get(name);
            if (!resolve) throw recordUnexpected(kind.toLowerCase(), name);
            const value = await resolve(args);
            if (value instanceof Error) throw value;
            const result = convexToJson((value ?? null) as Value);
            const ts = timestamp(tick + 1);
            socket?.reply({ ...response, success: true, result, ts });
            if (kind === "Mutation") transition([]);
          } catch (error) {
            socket?.reply({
              ...response,
              success: false,
              result: String(error),
              ...errorData(error),
            });
          }
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

  function functionPath(ref: FunctionReference<Kind>) {
    const name = getFunctionName(ref);
    return name.includes(":") ? name : name + ":default";
  }

  function resolver<Ref extends FunctionReference<Kind>>(
    reply: unknown,
  ): Resolver {
    return typeof reply === "function"
      ? (args) =>
          (reply as (args: FunctionArgs<Ref>) => unknown)(
            args as FunctionArgs<Ref>,
          )
      : () => reply;
  }

  return {
    client,
    queryRequests,
    mutations,
    actions,
    writeRequests,
    set<Ref extends FunctionReference<"query">>(
      ref: Ref,
      reply: QueryReply<NoInfer<Ref>>,
    ) {
      const name = functionPath(ref);
      queries.set(name, resolver<Ref>(reply));
      const active = [...subscriptions.values()].filter(
        (sub) => sub.udfPath === name,
      );
      if (active.length) transition(active.map(update));
    },
    mutation<Ref extends FunctionReference<"mutation">>(
      ref: Ref,
      reply: WriteReply<NoInfer<Ref>>,
    ) {
      writes.Mutation.set(functionPath(ref), resolver<Ref>(reply));
    },
    action<Ref extends FunctionReference<"action">>(
      ref: Ref,
      reply: WriteReply<NoInfer<Ref>>,
    ) {
      writes.Action.set(functionPath(ref), resolver<Ref>(reply));
    },
    assertRegistered() {
      if (unexpected.size) throw new Error([...unexpected].join("\n"));
    },
  };
}
