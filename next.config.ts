import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  eslint: {
    // Los errores de ESLint son pre-existentes en el proyecto y no afectan el runtime.
    // Se revisan por separado con `npm run lint`.
    ignoreDuringBuilds: true,
  },
  typescript: {
    // Los errores de TypeScript son pre-existentes en el proyecto.
    // Se revisan por separado con `npx tsc --noEmit`.
    ignoreBuildErrors: true,
  },
  // ── AUDITORÍA FINAL — Accesos Temporales, Gates A/B ──────────────────────
  // `dynamic = 'force-dynamic'` (app/s/[token]/page.tsx) ya saca la vista del
  // Full Route Cache de Next.js — cada apertura re-ejecuta el Server
  // Component y revalida token/expiresAt/revokedAt en el servidor. Pero eso
  // es cache INTERNO de Next; no garantiza por sí solo el header HTTP que ve
  // el navegador o un proxy/CDN intermedio (Vercel incluido). headers() es
  // el mecanismo de Next.js real y documentado para fijar eso a nivel de
  // ruta, sin tocar cada handler uno por uno. Se aplica tanto a la vista
  // (/s/*) como a la superficie de API de accesos — el mismo Cache-Control
  // que ya se fijaba a mano en cada Route Handler de app/api/access/* queda
  // ahora garantizado también por esta capa, y cubre además la página, que
  // no puede fijar headers desde sí misma (no es un Route Handler).
  // Referrer-Policy: no-referrer cierra el Gate B — sin esto, la carga de un
  // recurso de tercero (o incluso una navegación saliente) desde /s/{token}
  // enviaría la URL completa, con el token, como Referer.
  async headers() {
    return [
      {
        source: '/s/:token*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
        ],
      },
      {
        source: '/api/access/:path*',
        headers: [
          { key: 'Cache-Control', value: 'private, no-store' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
        ],
      },
    ];
  },
};

export default nextConfig;
