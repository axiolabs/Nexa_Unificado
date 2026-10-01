import { ROLE } from '@/lib/authz'

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  // El placeholder se renderiza con este Shape. Cuando el panel exista de verdad,
  // lo unico que cambia es el contenido: el gate ya esta en middleware.ts y el
  // rol ya esta declarado arriba. Agregar un rol nuevo es copiar estos 4 archivos.
  return <div data-role={ROLE.ADMIN}>{children}</div>
}
