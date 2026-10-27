import type { Metadata } from "next";
import Script from "next/script";
import "./globals.css";
const title = "HoodFees — Claim Creator Fees on Robinhood Chain";
const description =
  "Find and claim creator, deployer and referral fees on Robinhood Chain. Check O1, Bags, Bankr, Long/Longbow, pons and PAIR balances and track verified payouts with your wallet.";
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
      <body>
        {children}
        <Script
          src="https://www.googletagmanager.com/gtag/js?id=G-28DT31Z487"
          strategy="afterInteractive"
        />
        <Script id="google-analytics" strategy="afterInteractive">
          {`
            window.dataLayer = window.dataLayer || [];
            function gtag(){dataLayer.push(arguments);}
            gtag('js', new Date());
            gtag('config', 'G-28DT31Z487');
          `}
        </Script>
      </body>
    </html>
  );
}
