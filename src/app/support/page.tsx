import type { Metadata } from 'next';
import Link from 'next/link';
import InfoPage, { CONTACT_URL } from '@/components/InfoPage';

// The store listings' support URL, also linked from the app's legend. It must lead to a
// working way to reach us (App Store guideline 1.5).

export const metadata: Metadata = {
  title: 'Support · Texas Flood Map',
  description: 'Help with the Texas Flood Map app and how to contact us.',
};

export default function SupportPage() {
  return (
    <InfoPage title="Support">
      <p>
        Texas Flood Map shows the latest river gauge readings and flood stages across Texas on one
        map, using public data from the NOAA National Water Prediction Service and the U.S.
        Geological Survey, with National Weather Service flood warnings and watches and USGS river
        cameras.
      </p>
      <p>
        <strong>It is not an official warning service.</strong> Readings can be late, wrong or
        missing. In an emergency call 911, and for official flood information check{' '}
        <a href="https://www.weather.gov/">weather.gov</a> and your local authorities.
      </p>

      <h2>Contact us</h2>
      <p>
        To report a problem, ask a question or suggest a gauge or feature, open an issue on the
        project&apos;s <a href={CONTACT_URL}>GitHub issues page</a> (a free GitHub account is
        needed). Please include your phone model, and the gauge name if the question is about a
        gauge.
      </p>
      <p>
        For refunds of an App Store purchase, use Apple&apos;s{' '}
        <a href="https://reportaproblem.apple.com/">Report a Problem</a> page.
      </p>

      <h2>Common questions</h2>
      <p><strong>How current is the data?</strong> Gauge readings are refreshed about every 10 to 15 minutes. NOAA and USGS gauges themselves usually report every 15 to 60 minutes. The legend shows when the data was last updated and warns you if it is old.</p>
      <p><strong>What do gray and tan gauges mean?</strong> Gray means there is no recent reading. Tan means the National Weather Service has not set flood stages for that gauge, so it cannot be colored by flood level. Neither one means the river is safe.</p>
      <p><strong>The map shows no gauges.</strong> The app could not reach our server. Check your internet connection; the map fills in on its own once it is back. If you have used the app before, it shows the last readings it saved, with their age.</p>
      <p><strong>The locate button does not work.</strong> The app needs location access while you are using it. On iPhone, go to Settings &rarr; Privacy &amp; Security &rarr; Location Services &rarr; Texas Flood Map and choose &ldquo;While Using the App&rdquo;.</p>
      <p><strong>Does the app send me flood alerts?</strong> No. It does not send notifications. Use your phone&apos;s emergency alerts and the National Weather Service for warnings.</p>
      <p><strong>What data does the app collect?</strong> Only anonymous usage counts, which you can switch off. See the <Link href="/privacy">privacy policy</Link>.</p>
    </InfoPage>
  );
}
