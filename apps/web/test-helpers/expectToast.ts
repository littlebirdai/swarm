import { expect } from "bun:test";
import { act } from "react";
import { waitForDom } from "./waitForDom";

export async function expectToast(
  type: "success" | "error" | "warning" | "info",
  title: string,
) {
  const matching = () =>
    [...document.querySelectorAll("[data-sonner-toast]")].filter(
      (toast) => toast.querySelector("[data-title]")?.textContent === title,
    );
  await act(() => waitForDom(document.body, () => matching().length > 0));
  expect(matching().map((toast) => toast.getAttribute("data-type"))).toEqual([
    type,
  ]);
}
