import { queryOptions } from "@tanstack/react-query";
import type {
  AppearancePage,
  ClaimDetail,
  ClaimList,
  DeletePreview,
  EmailSettingsPage,
  FormEditor,
  FormList,
  GeneralSettingsPage,
  PrivacyNoticeRow,
  RetryPage,
  SearchGroup,
  TemplateChoice,
  TemplateDetail,
  TemplateRow,
} from "@reimbursements/shared/api/admin";
import { api } from "@/lib/api";

/** The admin area's queries (GET /api/v1/admin/...); mutations call `api` directly. */

export type ClaimsSearch = {
  status?: string;
  form?: string;
  q?: string;
  year?: string;
  month?: string;
  day?: string;
  page?: number;
};

export type FormsSearch = { status?: string; primary?: string; template?: string; q?: string; page?: number };

export const claimsQuery = (search: ClaimsSearch) =>
  queryOptions({
    queryKey: ["admin", "claims", search],
    queryFn: ({ signal }) => api.get<ClaimList>("/admin/claims", search, signal),
  });

export const claimQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "claim", id],
    queryFn: ({ signal }) => api.get<ClaimDetail>(`/admin/claims/${id}`, undefined, signal),
  });

export const retryQuery = (id: string) =>
  queryOptions({
    queryKey: ["admin", "claim", id, "retry"],
    queryFn: ({ signal }) => api.get<RetryPage>(`/admin/claims/${id}/retry`, undefined, signal),
    staleTime: 0,
  });

export const deletionQuery = (ids: string[]) =>
  queryOptions({
    queryKey: ["admin", "claims", "deletion", ids],
    queryFn: ({ signal }) => api.get<DeletePreview>("/admin/claims/deletion", { ids: ids.join(",") }, signal),
    staleTime: 0,
  });

export const formsQuery = (search: FormsSearch) =>
  queryOptions({
    queryKey: ["admin", "forms", search],
    queryFn: ({ signal }) => api.get<FormList>("/admin/forms", search, signal),
  });

export const formTemplatesQuery = queryOptions({
  queryKey: ["admin", "forms", "templates"],
  queryFn: ({ signal }) => api.get<TemplateChoice[]>("/admin/forms/templates", undefined, signal),
});

export const formEditorQuery = (target: { id: number } | { template: number }) =>
  queryOptions({
    queryKey: ["admin", "form-editor", target],
    queryFn: ({ signal }) =>
      "id" in target
        ? api.get<FormEditor>(`/admin/forms/${target.id}`, undefined, signal)
        : api.get<FormEditor>("/admin/forms/new", { template: target.template }, signal),
    // The editor keeps what one types; it reads the form once per visit. Its
    // saves are not in the cache: the next visit reads the form again.
    staleTime: Infinity,
    gcTime: 0,
    refetchOnWindowFocus: false,
  });

export const templatesQuery = (q = "") =>
  queryOptions({
    queryKey: ["admin", "templates", q],
    queryFn: ({ signal }) => api.get<TemplateRow[]>("/admin/templates", { q }, signal),
  });

export const templateQuery = (id: number | null) =>
  queryOptions({
    queryKey: ["admin", "template", id],
    queryFn: ({ signal }) =>
      api.get<TemplateDetail>(
        id === null ? "/admin/templates/new" : `/admin/templates/${id}`,
        undefined,
        signal,
      ),
    staleTime: Infinity,
    refetchOnWindowFocus: false,
  });

export const privacyNoticesQuery = queryOptions({
  queryKey: ["admin", "privacy-notices"],
  queryFn: ({ signal }) => api.get<PrivacyNoticeRow[]>("/admin/privacy-notices", undefined, signal),
});

export type PrivacyNoticeDetail = PrivacyNoticeRow & { text: string };

export const privacyNoticeQuery = (id: number) =>
  queryOptions({
    queryKey: ["admin", "privacy-notice", id],
    queryFn: ({ signal }) => api.get<PrivacyNoticeDetail>(`/admin/privacy-notices/${id}`, undefined, signal),
  });

export const newPrivacyNoticeQuery = queryOptions({
  queryKey: ["admin", "privacy-notices", "new"],
  queryFn: ({ signal }) => api.get<{ text: string }>("/admin/privacy-notices/new", undefined, signal),
  staleTime: Infinity,
  refetchOnWindowFocus: false,
});

export const generalQuery = queryOptions({
  queryKey: ["admin", "settings", "general"],
  queryFn: ({ signal }) => api.get<GeneralSettingsPage>("/admin/settings/general", undefined, signal),
  refetchOnWindowFocus: false,
});

export const emailQuery = queryOptions({
  queryKey: ["admin", "settings", "email"],
  queryFn: ({ signal }) => api.get<EmailSettingsPage>("/admin/settings/email", undefined, signal),
  refetchOnWindowFocus: false,
});

export const appearanceQuery = queryOptions({
  queryKey: ["admin", "settings", "appearance"],
  queryFn: ({ signal }) => api.get<AppearancePage>("/admin/settings/appearance", undefined, signal),
  refetchOnWindowFocus: false,
});

export const searchQuery = (q: string) =>
  queryOptions({
    queryKey: ["admin", "search", q],
    queryFn: ({ signal }) => api.get<SearchGroup[]>("/admin/search/all", { q }, signal),
  });
