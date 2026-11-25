export function patchEnv(vars: Record<string, string | undefined>): () => void {
  const previous = Object.keys(vars).map(
    (key) => [key, process.env[key]] as const,
  );
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}
