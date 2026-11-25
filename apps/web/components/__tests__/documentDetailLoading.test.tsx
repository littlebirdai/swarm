import { api } from "@codecast/convex/convex/_generated/api";
import { describe, expect, test } from "bun:test";
import type { ComponentProps } from "react";
import { webBuilders } from "../../test-helpers/builders";
import { mountWeb } from "../../test-helpers/mountWeb";
import { DocumentDetailLayout } from "../DocumentDetailLayout";

async function render(
  props: Partial<ComponentProps<typeof DocumentDetailLayout>>,
) {
  const doc = webBuilders("documentDetailLoading.test.tsx").doc.build({
    title: "My Doc",
    content: "",
  });
  const { container } = await mountWeb(
    <DocumentDetailLayout
      docId={doc._id}
      title={doc.title}
      markdownContent={doc.content}
      onTitleChange={() => {}}
      backHref="/docs"
      {...props}
    />,
    {
      path: `/docs/${doc._id}`,
      setup: (backend) => {
        backend.set(api.docSync.getPresence, []);
        backend.set(api.assistant.incidents.thinkingAvailable, undefined);
      },
    },
  );
  return container;
}

describe("DocumentDetailLayout body modes", async () => {
  test("editable docs mount the collab editor by default (edit-first)", async () => {
    const container = await render({
      markdownContent: "## The idea",
      contentReady: true,
    });
    expect(container.querySelector(".doc-editor")).not.toBeNull();
    expect(container.querySelector(".doc-read-body")).toBeNull();
  });

  // The review body's three empty-content states (opted out of edit mode).
  test("review: content not yet synced → loader, never a blank or 'empty' body", async () => {
    const container = await render({
      markdownContent: "",
      contentReady: false,
      defaultEditing: false,
    });
    expect(container.querySelector(".app-loader-bar")).not.toBeNull();
    expect(container.textContent).not.toContain("Empty document");
  });

  test("review: confirmed-empty doc → the empty-document affordance, no loader", async () => {
    const container = await render({
      markdownContent: "",
      contentReady: true,
      defaultEditing: false,
    });
    expect(container.textContent).toContain("Empty document");
    expect(container.querySelector(".app-loader-bar")).toBeNull();
  });

  test("review: loaded content renders through the review blocks", async () => {
    const container = await render({
      markdownContent: "## The idea",
      contentReady: true,
      defaultEditing: false,
    });
    expect(container.textContent).toContain("The idea");
    expect(container.querySelector(".app-loader-bar")).toBeNull();
    expect(container.textContent).not.toContain("Empty document");
  });
});

// The title-in-body mode: the doc is one text whose first heading is the
// title. Edit mode has NO separate h1 (the editor's first block is the
// title); review mode splits the leading heading off the body and renders it
// as a static heading in the same spot.
describe("DocumentDetailLayout titleInBody", async () => {
  test("edit mode renders no separate title element", async () => {
    const container = await render({
      titleInBody: true,
      markdownContent: "# Real Title\n\nbody",
      contentReady: true,
    });
    expect(container.querySelector(".doc-editor")).not.toBeNull();
    expect(container.querySelector("h1")).toBeNull();
  });

  test("review mode shows the leading heading as the title and strips it from the body", async () => {
    const container = await render({
      titleInBody: true,
      markdownContent: "# Real Title\n\nbody text",
      contentReady: true,
      defaultEditing: false,
    });
    expect(container.textContent).toContain("Real Title");
    const review = container.querySelector(".doc-read-body")?.textContent;
    expect(review).toContain("body text");
    expect(review).not.toContain("Real Title");
  });

  test("review mode falls back to the stored title when the body has no heading yet", async () => {
    const container = await render({
      titleInBody: true,
      markdownContent: "legacy body",
      contentReady: true,
      defaultEditing: false,
    });
    expect(container.textContent).toContain("My Doc");
    expect(container.textContent).toContain("legacy body");
  });

  test("a doc that is only a title counts as empty in review mode", async () => {
    const container = await render({
      titleInBody: true,
      markdownContent: "# Just a Title\n",
      contentReady: true,
      defaultEditing: false,
    });
    expect(container.textContent).toContain("Empty document");
    expect(container.textContent).toContain("Just a Title");
  });
});
