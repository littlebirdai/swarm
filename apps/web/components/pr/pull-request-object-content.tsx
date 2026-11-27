import { useContext } from "react";
import {
  usePullRequestDetail,
  useSyncPullRequestDetail,
} from "../../hooks/useSyncTimeline";
import { pullRequestBodyDetailEnabled } from "../../lib/detail-rows";
import { EntityFixtureContext } from "../../lib/entityDisplay";
import { stripMarkdown } from "../../lib/notificationText";
import { CardMarkdown } from "../EntityCardRows";
import type { DiffFile } from "../FileDiffView";
import { PullRequestFiles } from "./PullRequestFiles";

type Props = {
  entity: { _id?: string; body?: string; files?: DiffFile[] | null };
  expanded?: boolean;
  compact?: boolean;
};

export function PullRequestObjectContent(props: Props) {
  const fixtures = useContext(EntityFixtureContext);
  const id = props.entity._id;
  return props.expanded && pullRequestBodyDetailEnabled() && !fixtures && id ? (
    <LivePullRequestObjectContent {...props} id={id} />
  ) : (
    <PullRequestObjectBody {...props} fileFeedId={id} />
  );
}

function LivePullRequestObjectContent({
  id,
  entity,
  ...props
}: Props & { id: string }) {
  const feed = useSyncPullRequestDetail(id);
  const detail = usePullRequestDetail(id);
  return (
    <PullRequestObjectBody
      {...props}
      entity={{
        body: entity.body ?? detail?.body,
        files: entity.files ?? detail?.files,
      }}
      loading={!detail && !feed.ready && !feed.error}
    />
  );
}

function PullRequestObjectBody({
  entity,
  compact,
  expanded,
  fileFeedId,
  loading,
}: Props & { fileFeedId?: string; loading?: boolean }) {
  const { body, files } = entity;
  if (!expanded) {
    if (!body) return null;
    const clamp = compact ? "line-clamp-2" : "line-clamp-3";
    return (
      <p className={`text-[12px] leading-relaxed text-sol-text-muted ${clamp}`}>
        {stripMarkdown(body).slice(0, 400)}
      </p>
    );
  }
  return (
    <div className="space-y-2.5">
      {body ? (
        <CardMarkdown content={body} />
      ) : loading ? null : (
        <p className="text-meta italic text-sol-text-dim">No description.</p>
      )}
      <PullRequestFiles
        id={fileFeedId}
        files={files}
        emptyText={loading ? undefined : "No file changes synced yet"}
        className="overflow-hidden rounded border border-sol-border/40"
      />
    </div>
  );
}
