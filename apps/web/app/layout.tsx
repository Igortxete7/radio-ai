import type { Metadata } from 'next';
import { GeistSans } from 'geist/font/sans';
import './globals.css';
export const metadata: Metadata = {
  title: 'Radio AI · Control de emisión',
  description: 'Administración de una emisora musical con DJ generado por IA',
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body className={GeistSans.className}>{children}</body>
    </html>
  );
}
