// app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import UserProvider from "@/app/Components/UserProvider";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "StorkHub | Delivery y Mensajería en Managua",
  description:
    "Agencia de delivery en Managua: entregas express, cobros contra entrega, seguimiento en tiempo real y depósito diario. Cubrimos Managua, Tipitapa, Ticuantepe, Ciudad Sandino y municipios aledaños.",
  keywords: [
    "envíos Managua",
    "mensajería Nicaragua",
    "entregas express Nicaragua",
    "cobros contra entrega",
    "delivery Managua",
    "StorkHub",
    "SH Envíos",
  ],
  openGraph: {
    title: "StorkHub | Envíos express en Managua, Nicaragua",
    description:
      "Tu aliado logístico para entregas rápidas y cobros contra entrega en Managua. Sin contratos, pago diario y atención personalizada.",
    type: "website",
    locale: "es_NI",
    siteName: "StorkHub",
  },
  twitter: {
    card: "summary_large_image",
    title: "StorkHub | Envíos express en Managua",
    description:
      "Entregas rápidas, cobros contra entrega y seguimiento en tiempo real en Managua, Nicaragua.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="es">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <UserProvider>
          {children}
        </UserProvider>
      </body>
    </html>
  );
}
