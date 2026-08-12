import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { SCRIPT_DO_TEMA } from "@/components/tema";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Seahub Agentes",
  description: "Gestão de agentes de I.A. para atendimento — Seahub Coworking",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="pt-BR"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      // O tema escolhido é carimbado aqui por script, então o HTML servido não
      // bate com o do servidor quando alguém escolheu claro ou escuro.
      suppressHydrationWarning
    >
      <head>
        {/* Antes de qualquer pintura — ver SCRIPT_DO_TEMA. */}
        <script dangerouslySetInnerHTML={{ __html: SCRIPT_DO_TEMA }} />
      </head>
      <body className="font-sans min-h-full flex flex-col">{children}</body>
    </html>
  );
}
