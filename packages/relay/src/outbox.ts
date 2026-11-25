import type { RelayServerFrame } from "@codecast/relay-contract";
import { hubKey } from "./hubs";
import type { Publication } from "./signals";

export type Control = Exclude<RelayServerFrame, { seq: number }>;

type Pending =
  | { control: Control; expiresAt?: number }
  | { publication: Publication; recipientTtl: (now: number) => number };

export class Outbox {
  readonly #pending = new Map<string | number, Pending>();
  #nextControl = 0;
  readonly #capacity: number;

  constructor(capacity: number) {
    this.#capacity = capacity;
  }

  #makeRoom(): boolean {
    if (this.#pending.size < this.#capacity) return true;
    for (const key of this.#pending.keys()) {
      if (typeof key === "string") {
        this.#pending.delete(key);
        return true;
      }
    }
    return false;
  }

  control(control: Control, expiresAt?: number): boolean {
    if (!this.#makeRoom()) return false;
    this.#pending.set(this.#nextControl++, { control, expiresAt });
    return true;
  }

  signal(
    publication: Publication,
    recipientTtl: (now: number) => number,
  ): void {
    const { frame } = publication;
    const key = `${frame.connection_id}|${hubKey(frame.hub)}|${frame.type}`;
    this.#pending.delete(key);
    if (this.#makeRoom()) this.#pending.set(key, { publication, recipientTtl });
  }

  take(): Pending | undefined {
    const item = this.#pending.entries().next();
    if (item.done) return undefined;
    const [key, entry] = item.value;
    this.#pending.delete(key);
    return entry;
  }

  clear(): void {
    this.#pending.clear();
  }
}
