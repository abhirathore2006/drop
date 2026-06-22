import "./globals.css";

export const metadata = {
  title: "notes · drop",
  description: "A Postgres-backed Next.js app on Drop",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
