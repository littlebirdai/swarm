// True while the boot loader applies the disk cache to the store. Every writer
// skips disk while it is set, or hydration would write back what it just read.
export let _hydrating = false;

export function setHydrating(v: boolean) {
  _hydrating = v;
}
