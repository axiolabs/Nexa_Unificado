import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // argon2 es un modulo nativo: marcarlos como externos evita que Next lo
  // intente empaquetar para el edge, donde no tiene Node nativo.
  serverExternalPackages: ['argon2', '@prisma/client'],
}

export default nextConfig
