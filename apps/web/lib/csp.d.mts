export function contentSecurityPolicy(options?: {
  kratosUrl?: string;
  dev?: boolean;
  frameable?: boolean;
}): string;
export function securityHeaders(options?: {
  kratosUrl?: string;
  dev?: boolean;
  frameable?: boolean;
}): { key: string; value: string }[];
