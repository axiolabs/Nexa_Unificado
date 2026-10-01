import { ROLE } from '@/lib/authz'

export default function CurationLayout({ children }: { children: React.ReactNode }) {
  return <div data-role={ROLE.CURATOR}>{children}</div>
}
