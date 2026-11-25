import { expect } from "bun:test";

export function expectEmptyMount(container: HTMLElement) {
  const toaster = container.querySelector(
    ':scope > section[aria-label^="Notifications "]',
  );
  expect(toaster).not.toBeNull();
  expect(
    [...container.childNodes]
      .filter((node) => node !== toaster)
      .map((node) =>
        node instanceof Element ? node.outerHTML : node.textContent,
      ),
  ).toEqual([]);
}
