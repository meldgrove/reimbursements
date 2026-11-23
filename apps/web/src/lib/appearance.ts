import { useEffect } from "react";
import { stylesheet } from "@reimbursements/shared/theme";
import type { GeneralSettings } from "@reimbursements/shared/api/meta";

/**
 * The Appearance settings on every page: the accent color as a stylesheet over
 * the shared colors (light and dark), and the favicon.
 */
export function useAppearance(settings: GeneralSettings | undefined) {
  const accent = settings?.accentColor ?? "";
  const favicon = settings?.faviconDigest ?? "";
  const faviconType = settings?.faviconType ?? "";
  useEffect(() => {
    const id = "reimbursements-accent";
    let style = document.getElementById(id) as HTMLStyleElement | null;
    if (!accent) {
      style?.remove();
      return;
    }
    if (!style) {
      style = document.createElement("style");
      style.id = id;
      document.head.appendChild(style);
    }
    style.textContent = stylesheet(accent);
  }, [accent]);
  useEffect(() => {
    const link = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
    if (!link) return;
    link.href = favicon ? `/favicon/${favicon}/` : "/favicon.svg";
    link.type = favicon ? faviconType : "image/svg+xml";
  }, [favicon, faviconType]);
}
