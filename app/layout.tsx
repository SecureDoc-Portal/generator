import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'SecureDoc Portal',
  description: 'Build protected document viewers with revocable share links and QR codes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Serif+Display&display=swap"
        />
      </head>
      <body>
        <div className="bg-layer">
          <div className="orb orb-1" />
          <div className="orb orb-2" />
        </div>
        <div className="grid-overlay" />
        {children}
      </body>
    </html>
  );
}
