export function contentSecurityPolicy(options?: {
  kratosUrl?: string;
  dev?: boolean;
  frameable?: boolean;
  turnstileSiteKey?: string;
}): string;
export function securityHeaders(options?: {
  kratosUrl?: string;
  dev?: boolean;
  frameable?: boolean;
  turnstileSiteKey?: string;
}): { key: string; value: string }[];
