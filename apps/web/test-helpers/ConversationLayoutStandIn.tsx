import type { ComponentProps } from "react";
import type { ConversationDiffLayout } from "../components/ConversationDiffLayout";

export function ConversationLayoutStandIn(
  props: ComponentProps<typeof ConversationDiffLayout>,
) {
  return (
    <div
      data-layout={props.conversation._id}
      data-hide-header={props.hideHeader ? "1" : "0"}
      data-density={props.initialDensity ?? ""}
      data-hide-diff={props.hideDiff ? "1" : "0"}
      data-owner={props.isOwner ? "1" : "0"}
      data-focus-input={props.autoFocusInput ? "1" : "0"}
      data-fold-working={props.foldWorkingTurns ? "1" : "0"}
    >
      <header data-sv-convhead>
        {props.headerLeft}
        {props.headerExtra}
        {props.headerEnd}
      </header>
      {props.subHeaderContent}
      {props.leadNode}
      {props.isOwner && (
        <textarea data-composer placeholder={props.composerPlaceholder} />
      )}
    </div>
  );
}
