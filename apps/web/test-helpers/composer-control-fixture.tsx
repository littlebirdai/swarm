import { act, type ReactNode } from "react";
import { api } from "@codecast/convex/convex/_generated/api";
import "../components/chat/ChatMessage";
import { MessageInput } from "../components/message-input";
import { NonOwnerMessageInput } from "../components/conversation/session-controls";
import type { mountWeb } from "./mountWeb";
import { pending } from "./testConvex";
import type { ConversationData } from "../components/conversation/types";
import type {
  ComposerBaton,
  ComposerCommandOutcome,
  ComposerControlCommand,
  ComposerControlFacts,
  ComposerControlFlag,
} from "../components/conversation/composer-control-model";

export const ana = { id: "ana", name: "Ana" };
export const me = { id: "me", name: "Casey" };
let session = 0;

export function fakeBaton() {
  const commands: ComposerControlCommand[] = [];
  const replies: Array<{
    resolve: (value: ComposerCommandOutcome) => void;
    reject: (error: Error) => void;
  }> = [];
  const baton: ComposerBaton = {
    run(command) {
      commands.push(command);
      return new Promise((resolve, reject) =>
        replies.push({ resolve, reject }),
      );
    },
  };
  return {
    commands,
    control(
      conversationId: string,
      overrides: Partial<ComposerControlFacts> = {},
    ): ComposerControlFlag {
      return {
        enabled: true,
        conversationId,
        shared: {
          baton,
          facts: {
            viewerId: me.id,
            role: "owner",
            driver: me,
            turn: "t1",
            takeoverPending: false,
            driveRequested: false,
            sendState: null,
            ...overrides,
          },
        },
      };
    },
    async reply(result: ComposerCommandOutcome | Error) {
      const reply = replies.shift();
      if (!reply) throw new Error("No command to settle");
      await act(async () => {
        if (result instanceof Error) reply.reject(result);
        else reply.resolve(result);
      });
    },
  };
}

export function id() {
  return `control-test-${++session}`;
}

export function owner(
  conversationId: string,
  composerControl?: ComposerControlFlag,
  extra: Partial<React.ComponentProps<typeof MessageInput>> = {},
) {
  return (
    <MessageInput
      key={conversationId}
      conversationId={conversationId}
      composerControl={composerControl}
      status="active"
      agentType="claude_code"
      {...extra}
    />
  );
}

export function collaborator(
  conversationId: string,
  composerControl: ComposerControlFlag,
  onPopulateInput?: React.ComponentProps<
    typeof NonOwnerMessageInput
  >["onPopulateInput"],
) {
  return (
    <NonOwnerMessageInput
      conversation={{
        _id: conversationId as ConversationData["_id"],
        title: "Shared",
        messages: [],
      }}
      composerControl={composerControl}
      onPopulateInput={onPopulateInput}
    />
  );
}

export function createComposerMount(mount: typeof mountWeb) {
  return async function mountComposer(
    node: ReactNode,
    options: Parameters<typeof mountWeb>[1] = {},
  ) {
    const ui = await mount(node, {
      authenticated: true,
      dispatch: true,
      clock: options.clock ?? true,
      setup(backend, store) {
        backend.set(api.pendingMessages.getConversationPendingMessage, pending);
        backend.set(api.docSync.getPresence, []);
        backend.set(api.images.getImageUrls, pending);
        backend.mutation(api.docSync.updatePresence, null);
        backend.mutation(api.docSync.removePresence, null);
        backend.mutation(api.dispatch.dispatch, null);
        options.setup?.(backend, store);
      },
    });
    const box = () => {
      const input = ui.container.querySelector<HTMLTextAreaElement>(
        "textarea[data-chat-input]",
      );
      if (!input) throw new Error("Composer textarea missing");
      return input;
    };
    return {
      ...ui,
      box,
      async type(text: string) {
        await act(async () => {
          const input = box();
          const setValue = Object.getOwnPropertyDescriptor(
            ui.dom.window.HTMLTextAreaElement.prototype,
            "value",
          )!.set!;
          setValue.call(input, text);
          input.dispatchEvent(
            new ui.dom.window.Event("input", { bubbles: true }),
          );
        });
      },
      async press(key: string, options: KeyboardEventInit = {}, times = 1) {
        await act(async () => {
          for (let i = 0; i < times; i += 1)
            box().dispatchEvent(
              new ui.dom.window.KeyboardEvent("keydown", {
                key,
                bubbles: true,
                cancelable: true,
                ...options,
              }),
            );
        });
      },
    };
  };
}

export function button(root: ParentNode, name: string) {
  const match = [...root.querySelectorAll("button")].find(
    (control) =>
      (control.getAttribute("aria-label") ?? control.textContent?.trim()) ===
      name,
  );
  if (!match) throw new Error(`Button not found: ${name}`);
  return match;
}
