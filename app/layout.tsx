import type { Metadata } from "next";
import "./globals.css";
const title = "HoodFees — Claim Creator Fees on Robinhood Chain";
const description =
  "Find and claim creator, deployer and referral fees on Robinhood Chain. Check O1, Long/Longbow and pons balances and track verified payouts with your wallet.";
export const metadata: Metadata = {
  title,
  description,
  applicationName: "HoodFees",
  metadataBase: new URL("https://hoodfees.xyz"),
  alternates: { canonical: "/" },
  openGraph: { title, description, siteName: "HoodFees", type: "website", url: "/" },
  twitter: { card: "summary", title, description },
  icons: { icon: "/favicon.svg" },
  robots: { index: true, follow: true },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" style={{ colorScheme: "dark" }}>
      <body>{children}</body>
    </html>
  );
}
