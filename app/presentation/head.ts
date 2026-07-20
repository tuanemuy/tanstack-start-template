import type { AppConfig } from "@repo/core/application/di/types";

// 1200x630 — `summary_large_image` 互換サイズ。
const DEFAULT_OG_IMAGE_PATH = "/og-image.png";
const DEFAULT_LOCALE = "ja_JP";

export type HeadOverrides = Readonly<{
  title?: string;
  description?: string;
  path?: string;
  ogImage?: string;
  ogType?: "website" | "article";
}>;

type MetaTag =
  | { charSet: string }
  | { title: string }
  | { name: string; content: string }
  | { property: string; content: string };

type LinkTag = { rel: string; href: string };

// TanStack Router の `head()` 戻り値型が mutable array を要求するため readonly 不可。
export type HeadConfig = {
  meta: MetaTag[];
  links: LinkTag[];
};

function isAbsoluteUrl(value: string): boolean {
  return value.startsWith("http://") || value.startsWith("https://");
}

function joinUrl(appUrl: string, pathOrUrl: string): string {
  if (isAbsoluteUrl(pathOrUrl)) return pathOrUrl;
  const base = appUrl.replace(/\/$/, "");
  const path = pathOrUrl.startsWith("/") ? pathOrUrl : `/${pathOrUrl}`;
  return `${base}${path}`;
}

export function buildHead(
  config: AppConfig,
  overrides: HeadOverrides = {},
): HeadConfig {
  const title = overrides.title ?? config.defaultTitle;
  const description = overrides.description ?? config.defaultDescription;
  const ogType = overrides.ogType ?? "website";
  const url = joinUrl(config.appUrl, overrides.path ?? "/");
  const ogImage = joinUrl(
    config.appUrl,
    overrides.ogImage ?? DEFAULT_OG_IMAGE_PATH,
  );

  const meta: MetaTag[] = [
    { charSet: "utf-8" },
    { name: "viewport", content: "width=device-width, initial-scale=1" },
    { title },
    { name: "description", content: description },
    { name: "theme-color", content: config.themeColor },
    { name: "format-detection", content: "telephone=no" },
    { name: "mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-capable", content: "yes" },
    { name: "apple-mobile-web-app-status-bar-style", content: "default" },
    { name: "apple-mobile-web-app-title", content: config.siteName },
    { property: "og:type", content: ogType },
    { property: "og:url", content: url },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:image", content: ogImage },
    { property: "og:site_name", content: config.siteName },
    { property: "og:locale", content: DEFAULT_LOCALE },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: ogImage },
  ];
  if (config.twitterHandle !== undefined) {
    meta.push({ name: "twitter:site", content: config.twitterHandle });
  }

  const links: LinkTag[] = [{ rel: "canonical", href: url }];

  return { meta, links };
}
