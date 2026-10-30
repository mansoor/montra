import { redirect } from 'next/navigation';
import { load } from '@/lib/server-api';

export const dynamic = 'force-dynamic';

/** Entry point: first workspace, or onboarding when the user has none. */
export default async function Root() {
  const workspaces = await load((api) => api.listWorkspaces());
  redirect(workspaces[0] ? `/w/${workspaces[0].id}` : '/welcome');
}
