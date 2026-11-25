export function waitForDom(
  container: HTMLElement,
  ready: () => boolean,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const deadline = setTimeout(() => {
      observer.disconnect();
      reject(new Error("The expected DOM update did not render"));
    }, 1000);
    function check() {
      if (!ready()) return;
      clearTimeout(deadline);
      observer.disconnect();
      resolve();
    }
    observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    check();
  });
}
