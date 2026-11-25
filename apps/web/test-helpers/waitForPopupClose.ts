import { act } from "react";
import { waitForDom } from "./waitForDom";

export async function waitForPopupClose(): Promise<void> {
  await act(() =>
    waitForDom(
      document.body,
      () => !document.querySelector("[role=dialog], [role=menu]"),
    ),
  );
  await act(() => new Promise<void>((focused) => setTimeout(focused, 0)));
}
