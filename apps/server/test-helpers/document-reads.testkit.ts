type AsyncSyscall = (op: string, args: string) => Promise<string>;

export async function recordDocuments<T>(run: () => Promise<T>) {
  const runtime = (globalThis as unknown as { Convex: object }).Convex;
  const original = Object.getOwnPropertyDescriptor(runtime, "asyncSyscall")!;
  const reads = new Set<string>();
  const writes = new Set<string>();
  Object.defineProperty(runtime, "asyncSyscall", {
    ...original,
    get() {
      const call: AsyncSyscall = original.get!.call(runtime);
      return async (op: string, args: string) => {
        const result = await call(op, args);
        switch (op) {
          case "1.0/get":
            reads.add(JSON.parse(args).id);
            break;
          case "1.0/queryStreamNext": {
            const { value } = JSON.parse(result);
            if (value?._id) reads.add(value._id);
            break;
          }
          case "1.0/queryPage":
            for (const row of JSON.parse(result).page) reads.add(row._id);
            break;
          case "1.0/insert":
            writes.add(JSON.parse(result)._id);
            break;
          case "1.0/shallowMerge":
          case "1.0/replace":
          case "1.0/remove":
            writes.add(JSON.parse(args).id);
            break;
        }
        return result;
      };
    },
  });
  try {
    return { result: await run(), reads, writes };
  } finally {
    Object.defineProperty(runtime, "asyncSyscall", original);
  }
}
