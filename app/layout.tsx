import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'Nexa',
  description: 'Planes con gente nueva.',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>{children}</body>
    </html>
  )
}
