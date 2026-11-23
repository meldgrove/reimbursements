import { useRouterState } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@meldgrove/ui/card";
import { Page, PageHeader } from "@meldgrove/ui/page";
import { ErrorState, LoadingState } from "@meldgrove/ui/states";
import { privacyNoticeVersionRoute } from "../routes";
import { privacyNoticeQuery } from "../api";
import { DetailList, useRecordName } from "../parts";

/** One version of the privacy notice, as saved; versions are never changed. */
export function PrivacyNoticeVersionPage() {
  const { noticeId } = privacyNoticeVersionRoute.useParams();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const query = useQuery(privacyNoticeQuery(Number(noticeId)));
  useRecordName(pathname, query.data ? `Version ${query.data.version}` : null);
  if (query.isPending) return <LoadingState />;
  if (query.isError) return <ErrorState error={query.error} onRetry={() => void query.refetch()} />;
  const notice = query.data;
  return (
    <Page className="max-w-4xl">
      <PageHeader
        title={`Version ${notice.version}`}
        description={
          notice.current
            ? "Privacy notice · the version participants see"
            : "Privacy notice · an earlier version"
        }
      />
      <Card className="gap-0 py-0">
        <DetailList
          rows={[
            ["Created", notice.createdAt],
            ["Created by", notice.createdBy],
          ]}
        />
      </Card>
      <Card className="px-6">
        <div className="text-sm whitespace-pre-wrap">{notice.text}</div>
      </Card>
    </Page>
  );
}
