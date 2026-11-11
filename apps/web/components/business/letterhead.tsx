import type { BusinessProfileDto } from '@montra/api-client';

/**
 * How the business heads its invoices (ADR-0032): the logo, the name and the domain, as the PDF prints them. The logo
 * comes through the API proxy with the session; the file id in the URL refreshes a cached copy after a new upload.
 */
export function Letterhead({
  workspaceId,
  profile,
  logoAlt,
}: {
  workspaceId: string;
  profile: BusinessProfileDto;
  logoAlt: string;
}) {
  const src = profile.logoFileId
    ? `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/businesses/${encodeURIComponent(profile.entityId)}/logo?v=${encodeURIComponent(profile.logoFileId)}`
    : null;
  return (
    <div className="flex items-center gap-3" data-testid="letterhead">
      {src && (
        // A plain img: next/image would fetch this private image on the server, without the session.
        <img src={src} alt={logoAlt} className="h-10 max-w-[10rem] rounded-md bg-white object-contain p-1" />
      )}
      <div className="text-sm">
        <p className="font-semibold">{profile.legalName ?? profile.name}</p>
        {profile.domain && <p className="text-muted">{profile.domain}</p>}
      </div>
    </div>
  );
}
