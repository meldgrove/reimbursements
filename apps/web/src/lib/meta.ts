import { queryOptions, useQuery, useSuspenseQuery } from "@tanstack/react-query";
import type { Meta, MeUser } from "@reimbursements/shared/api/meta";
import { api } from "./api";

/** What every page needs (GET /api/v1/meta): the settings, the signed-in person, the sign-in. */
export const metaQuery = queryOptions({
  queryKey: ["meta"],
  queryFn: ({ signal }) => api.get<Meta>("/meta", undefined, signal),
  staleTime: 60_000,
});

/** The meta answer; the root route loads it before any page renders. */
export function useMeta(): Meta {
  return useSuspenseQuery(metaQuery).data;
}

/** The meta answer while it loads in the background (undefined until then). */
export function useMetaMaybe(): Meta | undefined {
  return useQuery(metaQuery).data;
}

/** The signed-in person of the admin area; the admin layout makes sure there is one. */
export function useMe(): MeUser {
  const me = useMeta().user;
  if (!me) throw new Error("useMe outside the signed-in admin area");
  return me;
}

export function useIsTemplateAdmin(): boolean {
  return Boolean(useMeta().user?.isTemplateAdmin);
}
