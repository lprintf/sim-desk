import type { Metadata, Viewport } from "next";
import "./globals.css";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidebarProvider } from "@/components/ui/sidebar";

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: '#09090b', // matches dark background
};

export const metadata: Metadata = {
  title: "Sim Desk",
  description: "Mobile workspace for Codex CLI",
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Sim Desk',
  },
  other: {
    'mobile-web-app-capable': 'yes',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="dark">
      <body suppressHydrationWarning className="font-sans antialiased">
        <SidebarProvider>
          <TooltipProvider delayDuration={200}>
            {children}
          </TooltipProvider>
        </SidebarProvider>
      </body>
    </html>
  );
}
