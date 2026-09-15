import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Formbridge",
  description: "The secure access layer for AI agents operating Formlabs print workflows.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
