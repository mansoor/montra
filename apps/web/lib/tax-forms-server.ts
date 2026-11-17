import type { AccountDto, ApiClient, EmployerDto, FamilyMemberDto, WorkspaceDto } from '@montra/api-client';
import { serverApi } from '@/lib/server-api';
import type { AccountOption, EmployerOption, Option } from '@/components/tax-forms/tax-form-editor';

/**
 * What both tax form pages need to type in and match a form: the household's people, its employers and accounts, and
 * who may do what. Employers are private to their person (PAY-09), so an accountant gets none and doesn't match a W-2
 * to one.
 */
export async function taxFormContext(
  workspace: WorkspaceDto,
  members: FamilyMemberDto[],
  accounts: AccountDto[],
): Promise<{
  members: Option[];
  employers: EmployerOption[];
  accounts: AccountOption[];
  canWrite: boolean;
  canMatchEmployer: boolean;
}> {
  const api: ApiClient = await serverApi();
  const employers: EmployerDto[] =
    workspace.role === 'accountant' ? [] : await api.listEmployers(workspace.id).catch(() => []);
  return {
    members: members.filter((m) => m.status === 'active').map((m) => ({ id: m.id, name: m.name })),
    employers: employers
      .filter((e) => !e.archived && e.type === 'employer')
      .map((e) => ({ id: e.id, name: e.name, memberId: e.memberId })),
    accounts: accounts.filter((a) => !a.archived).map((a) => ({ id: a.id, name: a.name, kind: a.kind })),
    canWrite: workspace.role !== 'viewer',
    canMatchEmployer: workspace.role !== 'accountant' && workspace.role !== 'viewer',
  };
}
