import { ROLE } from '@/lib/authz'

export default function HostLayout({ children }: { children: React.ReactNode }) {
  return <div data-role={ROLE.HOST}>{children}</div>
}
